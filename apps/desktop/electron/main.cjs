const { app, BrowserWindow, shell } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");

const gatewayPort = process.env.AZC_PORT || "8788";
let gateway;

function startGateway() {
  const entry = path.resolve(__dirname, "../../gateway/src/index.ts");
  const dataDir = path.join(app.getPath("userData"), "data");
  gateway = spawn(process.execPath, ["--experimental-strip-types", entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AZC_PORT: gatewayPort,
      AZC_HOST: "127.0.0.1",
      AZC_DATA_DIR: dataDir,
    },
    stdio: "inherit",
  });
  gateway.on("exit", (code) => {
    if (code && code !== 0) console.error(`gateway exited ${code}`);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 780,
    minHeight: 560,
    title: "AutoZCoder",
    backgroundColor: "#f5f5f7",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = url.startsWith("file:") || url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:");
    if (!allowed) event.preventDefault();
  });
  const devUrl = process.env.AZC_RENDERER_URL;
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(__dirname, "../dist/index.html"));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    startGateway();
    createWindow();
  });
  app.on("window-all-closed", () => {
    if (gateway) gateway.kill();
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    if (gateway) gateway.kill();
  });
}
