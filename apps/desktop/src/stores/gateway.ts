import { defineStore } from "pinia";

export const useGateway = defineStore("gateway", {
  state: () => ({
    base: window.azc?.gatewayUrl || localStorage.getItem("azc.base") || "http://127.0.0.1:8788",
    adminKey: window.azc?.adminKey || localStorage.getItem("azc.adminKey") || "",
    clientKey: window.azc?.clientKey || localStorage.getItem("azc.clientKey") || "",
    error: "",
    loading: false,
  }),
  actions: {
    saveKeys() {
      localStorage.setItem("azc.base", this.base);
      localStorage.setItem("azc.adminKey", this.adminKey);
      localStorage.setItem("azc.clientKey", this.clientKey);
    },
    async request(path: string, options: { admin?: boolean; method?: string; body?: unknown } = {}) {
      this.loading = true;
      this.error = "";
      try {
        const headers: Record<string, string> = {};
        const key = options.admin === false ? this.clientKey : this.adminKey;
        if (key) headers.authorization = `Bearer ${key}`;
        if (options.body != null) headers["content-type"] = "application/json";
        const response = await fetch(`${this.base}${path}`, {
          method: options.method ?? (options.body != null ? "POST" : "GET"),
          headers,
          body: options.body != null ? JSON.stringify(options.body) : undefined,
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : null;
        if (!response.ok) {
          const message = data?.detail || data?.error?.message || `${response.status}`;
          throw new Error(message);
        }
        return data;
      } catch (error) {
        this.error = error instanceof Error ? error.message : "request failed";
        throw error;
      } finally {
        this.loading = false;
      }
    },
  },
});
