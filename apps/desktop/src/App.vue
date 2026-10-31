<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useGateway } from "./stores/gateway.ts";

const route = useRoute();
const router = useRouter();
const gateway = useGateway();

const items = [
  { to: "/", label: "Overview" },
  { to: "/accounts", label: "Accounts" },
  { to: "/models", label: "Models" },
  { to: "/usage", label: "Usage" },
  { to: "/settings", label: "Settings" },
];

const theme = computed(() => document.documentElement.dataset.theme || "light");

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("azc.theme", next);
}

function go(path: string) {
  router.push(path);
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <aside class="flex w-56 shrink-0 flex-col border-r px-3 py-4" style="background: var(--surface); border-color: var(--line)">
      <div class="px-2 pb-4">
        <div class="text-[13px] font-semibold tracking-tight">AutoZCoder</div>
        <div class="text-[11px]" style="color: var(--muted)">Local gateway</div>
      </div>
      <nav class="flex flex-col gap-1">
        <button
          v-for="item in items"
          :key="item.to"
          type="button"
          class="rounded-lg px-3 py-2 text-left text-[13px]"
          :style="route.path === item.to ? 'background: var(--accent); color: var(--accent-ink)' : 'color: var(--ink)'"
          @click="go(item.to)"
        >
          {{ item.label }}
        </button>
      </nav>
      <div class="mt-auto px-2 text-[11px]" style="color: var(--muted)">Rewrite · Node</div>
    </aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-12 items-center gap-3 border-b px-5" style="background: var(--surface); border-color: var(--line)">
        <div class="text-[13px] font-medium">{{ items.find((item) => item.to === route.path)?.label }}</div>
        <div class="ml-auto flex items-center gap-2 text-[12px]" style="color: var(--muted)">
          <span class="h-2 w-2 rounded-full" :style="gateway.error ? 'background: var(--danger)' : 'background: var(--ok)'"></span>
          {{ gateway.error ? "Not connected" : gateway.base }}
          <button type="button" class="rounded-md px-2 py-1" style="background: var(--surface-2)" @click="toggleTheme">
            {{ theme === "dark" ? "Light" : "Dark" }}
          </button>
        </div>
      </header>
      <main class="min-h-0 flex-1 overflow-auto p-5">
        <router-view />
      </main>
    </div>
  </div>
</template>
