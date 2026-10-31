import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router.ts";
import "./styles.css";

const saved = localStorage.getItem("azc.theme");
const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = theme;

createApp(App).use(createPinia()).use(router).mount("#app");
