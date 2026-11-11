import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { getRequestListener } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
  NONCE,
  secureHeaders,
  type SecureHeadersVariables,
} from "hono/secure-headers";
import { validator } from "hono/validator";
import QRCode from "qrcode";
import type { Address } from "viem";
import { loadConfig } from "./config.js";
import { keyStorageWarning, readWallet, saveWallet } from "./wallet.js";
import { getChainConfig } from "./chains.js";
import { readBalance } from "./balance.js";
import type { WalletSetupSession } from "./types.js";
import { setupAssetQuerySchema, setupInputSchema } from "./validation.js";

export function openBrowser(url: string) {
  const cannotOpenBrowser =
    process.env.SSH_CONNECTION ||
    process.env.SSH_TTY ||
    (process.platform === "linux" &&
      !process.env.DISPLAY &&
      !process.env.WAYLAND_DISPLAY);
  if (cannotOpenBrowser) return;

  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // The URL is a fixed origin plus a hex token, so it holds no characters cmd treats specially.
          ["cmd.exe", ["/d", "/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    // Without a listener onError a spawn failure (e.g. no xdg-open) would crash the CLI; the URL is already printed so no need to act.
  });
  child.unref();
}

type Env = {
  Variables: { address: Address } & SecureHeadersVariables;
};

const readAsset = (file: string) =>
  readFileSync(new URL(`../assets/${file}`, import.meta.url), "utf8");

// Served as one document because some viewers, such as Claude Desktop's, only load the top-level page.
function setupPage(nonce: string) {
  const logo = Buffer.from(readAsset("logo.svg")).toString("base64");
  // Function replacers keep `$` sequences in the assets literal.
  return readAsset("index.html")
    .replace(
      '<link rel="stylesheet" href="/style.css" />',
      () => `<style nonce="${nonce}">${readAsset("style.css")}</style>`,
    )
    .replace(
      '<script src="/app.js" defer></script>',
      () =>
        `<script type="module" nonce="${nonce}">${readAsset("app.js")}</script>`,
    )
    .replace(
      'src="/logo.svg"',
      () => `src="data:image/svg+xml;base64,${logo}"`,
    );
}

// Browsers and port forwards may name the server localhost; the port must still be the session's.
function trustedOrigins(session: WalletSetupSession) {
  return [session.origin, `http://localhost:${new URL(session.origin).port}`];
}

// Security headers, session expiry and Host/Origin checks, applied to every request including the page.
function setupSecureMiddleware(
  session: WalletSetupSession,
): MiddlewareHandler<Env>[] {
  const origins = trustedOrigins(session);
  const hosts = origins.map((origin) => new URL(origin).host);
  return [
    secureHeaders({
      referrerPolicy: "no-referrer",
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        scriptSrc: [NONCE],
        styleSrc: [NONCE],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
      },
    }),
    async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    },
    async (c, next) => {
      if (Date.now() >= session.expiresAt)
        return c.json(
          { error: "Setup session expired; open a new session." },
          410,
        );
      const origin = c.req.header("origin");
      // Host blocks DNS rebinding; Origin blocks other sites calling in.
      if (
        !hosts.includes(c.req.header("host") ?? "") ||
        (origin !== undefined && !origins.includes(origin))
      )
        return c.json({ error: "Untrusted origin" }, 403);
      await next();
    },
  ];
}

function walletRoutes(session: WalletSetupSession) {
  const app = new Hono<Env>();

  app.get("/status", (c) =>
    c.json({
      walletAddress: readWallet()?.address ?? null,
      chainId: session.chain.chainId,
      chains: Array.from(session.config.chainConfigs.values()).map(
        ({ chainId, chain, tokens }) => ({
          chainId,
          name: chain.name,
          nativeSymbol: chain.nativeCurrency.symbol,
          tokens,
        }),
      ),
    }),
  );

  app.post(
    "/wallet",
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "Request body is too large" }, 413),
    }),
    async (c) => {
      const input = setupInputSchema.safeParse(
        await c.req.json().catch(() => undefined),
      );
      if (!input.success)
        return c.json(
          { error: "Choose create or provide a valid private key to import." },
          400,
        );
      if (readWallet())
        return c.json(
          {
            error: "A wallet is already configured; it has not been replaced.",
          },
          409,
        );
      let saved;
      try {
        saved = await saveWallet(
          input.data.mode === "import"
            ? input.data.privateKey.trim()
            : undefined,
        );
      } catch {
        return c.json(
          {
            error:
              "Wallet was not saved. Check the key and directory access; an existing wallet cannot be replaced.",
          },
          400,
        );
      }
      const { privateKey, ...wallet } = saved;
      const warning = keyStorageWarning(saved.keyStorage);
      // Only this private browser response can contain a newly generated backup key.
      return c.json(
        {
          ...wallet,
          ...(input.data.mode === "create" ? { privateKey } : {}),
          ...(warning ? { warning } : {}),
        },
        201,
      );
    },
  );

  return app;
}

function fundingRoutes(session: WalletSetupSession) {
  const app = new Hono<Env>();

  const requireAccount: MiddlewareHandler<Env> = async (c, next) => {
    const wallet = readWallet();
    if (!wallet) {
      return c.json({ error: "Import or create a wallet first." }, 409);
    }
    c.set("address", wallet.address);
    await next();
  };

  const assetQuery = validator("query", (value, c) => {
    // Empty fields from the page fall back to the session's chain and its native asset.
    const query = setupAssetQuerySchema.safeParse(
      Object.fromEntries(Object.entries(value).filter(([, entry]) => entry)),
    );
    const chain = query.success
      ? session.config.chainConfigs.get(
          query.data.chainId ?? session.chain.chainId,
        )
      : undefined;
    const symbol =
      (query.success && query.data.asset) || chain?.chain.nativeCurrency.symbol;
    const token = chain?.tokens.find((entry) => entry.name === symbol);
    if (
      !chain ||
      !symbol ||
      (!token && symbol !== chain.chain.nativeCurrency.symbol)
    ) {
      return c.json({ error: "Unsupported network or asset" }, 400);
    }
    return { chain, symbol, token };
  });

  app.get("/deposit", requireAccount, assetQuery, async (c) => {
    const { chain, symbol, token } = c.req.valid("query");
    const address = c.get("address");
    // EIP-681 payment request; no amount, so the scanning wallet asks for it.
    const uri = token
      ? `ethereum:${token.address}@${chain.chainId}/transfer?address=${address}`
      : `ethereum:${address}@${chain.chainId}`;
    return c.json({
      address,
      chainId: chain.chainId,
      network: chain.chain.name,
      symbol,
      tokenAddress: token?.address ?? null,
      uri,
      qr: await QRCode.toDataURL(uri),
      nativeSymbol: chain.chain.nativeCurrency.symbol,
    });
  });

  app.get("/balance", requireAccount, assetQuery, async (c) => {
    const { chain, token } = c.req.valid("query");
    try {
      return c.json(
        await readBalance(c.get("address"), chain.chainId, token?.address),
      );
    } catch {
      return c.json(
        {
          error:
            "Balance unavailable: the RPC did not respond. Refresh to retry; this does not mean the balance is zero.",
        },
        502,
      );
    }
  });

  return app;
}

export function createSetupApp(session: WalletSetupSession) {
  const app = new Hono<Env>();

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error("Wallet setup request failed:", error);
    return c.json(
      { error: "Local wallet request failed. Check configuration and retry." },
      500,
    );
  });
  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.use(...setupSecureMiddleware(session));

  app.get("/", (c) => c.html(setupPage(c.get("secureHeadersNonce") ?? "")));

  // Registered after the page, which stays public; every API call carries the session token.
  app.use(
    bearerAuth({
      token: session.token.toString(),
      noAuthenticationHeaderMessage: { error: "Invalid setup session" },
      invalidAuthenticationHeaderMessage: { error: "Invalid setup session" },
      invalidTokenMessage: { error: "Invalid setup session" },
    }),
  );

  // Checking for wildcard pattern, not using csrf() as it skips JSON bodies (it only guards form content types). Require the page's exact origin here.
  const origins = trustedOrigins(session);
  app.post("*", async (c, next) => {
    if (
      !origins.includes(c.req.header("origin") ?? "") ||
      c.req.header("content-type") !== "application/json"
    )
      return c.json({ error: "Use the private setup page" }, 403);
    await next();
  });

  // Wallet status and the private create/import flow.
  app.route("/", walletRoutes(session));

  // Receive details and balances, needs a configured wallet.
  app.route("/", fundingRoutes(session));

  return app;
}

export async function startSetupSession(
  options: { chainId?: number; ttlMs?: number } = {},
) {
  const config = loadConfig();
  const chain = getChainConfig(
    options.chainId ?? config.activeChainConfig.chainId,
  );
  const expiresAt = Date.now() + (options.ttlMs ?? 10 * 60_000);
  const token = randomBytes(32).toString("hex");
  const server = createServer();
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not start private wallet setup");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const app = createSetupApp({
    token: Buffer.from(token),
    origin,
    expiresAt,
    config,
    chain,
  });
  server.on("request", getRequestListener(app.fetch));
  const close = () => {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  };
  const timer = setTimeout(close, Math.max(1, expiresAt - Date.now()));
  const closed = new Promise<void>((resolve) => server.once("close", resolve));
  return { url: `${origin}/#${token}`, expiresAt, close, closed };
}
