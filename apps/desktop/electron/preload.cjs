const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("azc", {
  gatewayUrl: `http://127.0.0.1:${process.env.AZC_PORT || "8788"}`,
  adminKey: process.env.AZC_ADMIN_KEY || "",
  clientKey: process.env.AZC_CLIENT_KEY || "",
});
