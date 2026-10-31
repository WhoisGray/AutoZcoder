export {};

declare global {
  interface Window {
    azc?: {
      gatewayUrl: string;
      adminKey: string;
      clientKey: string;
    };
  }
}
