"use strict";
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
const byId = (id) => document.getElementById(id);
let chains = [];
let poll;
let attempts = 0;
let selection = 0;
// Set when no OS keychain was available and the key went to a plain file.
let storageWarning = "";
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function message(text) {
  byId("message").textContent = text;
}
async function run(action) {
  try {
    await action();
  } catch (error) {
    message(error.message);
  }
}
function choice(value, name) {
  const option = document.createElement("option");
  option.value = String(value);
  option.textContent = name;
  return option;
}
async function refresh() {
  const current = selection;
  try {
    const data = await api(
      `/balance?chainId=${byId("chain").value}&asset=${encodeURIComponent(byId("asset").value)}`,
    );
    if (current === selection)
      byId("balance").textContent =
        `Balance: ${data.formatted}${data.symbol ? ` ${data.symbol}` : ""}. Your operation may also require other assets or gas.`;
  } catch (error) {
    if (current === selection) byId("balance").textContent = error.message;
  }
}
async function selectAsset() {
  const current = ++selection;
  clearInterval(poll);
  byId("qr").hidden = true;
  byId("open-wallet").hidden = true;
  byId("address").value = "";
  byId("contract").textContent = "";
  byId("balance").textContent = "Balance not checked.";
  const data = await api(
    `/deposit?chainId=${byId("chain").value}&asset=${encodeURIComponent(byId("asset").value)}`,
  );
  if (current !== selection) return;
  byId("address").value = data.address;
  byId("network").textContent =
    `${data.symbol} on ${data.network} (chain ${data.chainId})`;
  byId("contract").textContent = data.tokenAddress
    ? `Token contract: ${data.tokenAddress}`
    : "Native asset";
  byId("qr").src = data.qr;
  byId("qr").hidden = false;
  // Same EIP-681 request as the QR code, for a wallet app on this device.
  byId("open-wallet").href = data.uri;
  byId("open-wallet").hidden = false;
  byId("gas").textContent =
    `Transactions on this network use ${data.nativeSymbol} for gas. Funding one network does not fund another. Signature-only operations may not need gas.`;
  attempts = 0;
  await refresh();
  if (current !== selection) return;
  poll = setInterval(() => {
    if (++attempts >= 12) {
      clearInterval(poll);
      message(
        "Automatic balance checks stopped. Refresh manually when your deposit arrives.",
      );
    } else void refresh();
  }, 10_000);
}
async function selectChain() {
  const chain = chains.find(
    (entry) => String(entry.chainId) === byId("chain").value,
  );
  byId("asset").replaceChildren(
    choice(chain.nativeSymbol, `${chain.nativeSymbol} (gas)`),
    ...chain.tokens.map((token) => choice(token.name, token.name)),
  );
  if (chain.tokens.some((token) => token.name === "USDC"))
    byId("asset").value = "USDC";
  await selectAsset();
}
async function load() {
  const status = await api("/status");
  chains = status.chains;
  byId("setup").hidden = !!status.walletAddress;
  byId("receive").hidden = !status.walletAddress;
  if (status.walletAddress) {
    byId("chain").replaceChildren(
      ...chains
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((chain) => choice(chain.chainId, chain.name)),
    );
    byId("chain").value = String(status.chainId);
    await selectChain();
  }
}
async function save(body) {
  byId("create").disabled = true;
  byId("import").querySelector("button").disabled = true;
  let data;
  try {
    data = await api("/wallet", body);
  } finally {
    byId("key").value = "";
    byId("create").disabled = false;
    byId("import").querySelector("button").disabled = false;
  }
  byId("setup").hidden = true;
  storageWarning = data.warning ?? "";
  if (data.privateKey) {
    byId("backup-key").value = data.privateKey;
    byId("backup").hidden = false;
  } else {
    message(`Wallet imported: ${data.address}. ${storageWarning}`.trim());
    await load();
  }
}
byId("create").onclick = () => run(() => save({ mode: "create" }));
byId("import").onsubmit = (event) => {
  event.preventDefault();
  const privateKey = byId("key").value.trim();
  byId("key").value = "";
  void run(() => save({ mode: "import", privateKey }));
};
byId("saved").onclick = () =>
  run(async () => {
    byId("backup-key").value = "";
    byId("backup").hidden = true;
    message(
      `Wallet saved. Your receive address and QR code are below. ${storageWarning}`.trim(),
    );
    await load();
  });
byId("chain").onchange = () => run(selectChain);
byId("asset").onchange = () => run(selectAsset);
byId("refresh").onclick = () => run(refresh);
byId("copy").onclick = () =>
  run(async () => {
    await navigator.clipboard.writeText(byId("address").value);
    message("Address copied.");
  });
window.addEventListener("pagehide", () => {
  clearInterval(poll);
  byId("backup-key").value = "";
});
void run(async () => {
  await load();
  message("");
});
