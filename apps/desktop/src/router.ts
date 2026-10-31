import { createRouter, createWebHashHistory } from "vue-router";
import AccountsPage from "./pages/AccountsPage.vue";
import ModelsPage from "./pages/ModelsPage.vue";
import OverviewPage from "./pages/OverviewPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import UsagePage from "./pages/UsagePage.vue";

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "overview", component: OverviewPage },
    { path: "/accounts", name: "accounts", component: AccountsPage },
    { path: "/models", name: "models", component: ModelsPage },
    { path: "/usage", name: "usage", component: UsagePage },
    { path: "/settings", name: "settings", component: SettingsPage },
  ],
});
