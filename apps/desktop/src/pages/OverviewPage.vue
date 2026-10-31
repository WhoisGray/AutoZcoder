<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGateway } from "../stores/gateway.ts";

const gateway = useGateway();
const health = ref<Record<string, unknown> | null>(null);
const ready = ref<Record<string, any> | null>(null);
const pool = ref<Record<string, any> | null>(null);
const problem = ref("");

async function load() {
  problem.value = "";
  health.value = null;
  ready.value = null;
  try {
    const healthResponse = await fetch(`${gateway.base}/health`);
    if (!healthResponse.ok) throw new Error("health failed");
    health.value = await healthResponse.json();
    const readyResponse = await fetch(`${gateway.base}/ready`);
    ready.value = { status: readyResponse.status, ...(await readyResponse.json()) };
  } catch {
    problem.value = "Gateway unreachable";
    return;
  }
  if (!gateway.adminKey) {
    pool.value = null;
    return;
  }
  try {
    pool.value = await gateway.request("/admin/pool/state");
  } catch {
    pool.value = null;
  }
}

onMounted(() => {
  load().catch(() => undefined);
});
</script>

<template>
  <div class="grid gap-4 md:grid-cols-3">
    <section class="rounded-2xl p-4" style="background: var(--surface); box-shadow: var(--shadow)">
      <div class="text-[12px]" style="color: var(--muted)">Health</div>
      <div class="mt-2 text-2xl font-semibold">{{ health?.status ?? "—" }}</div>
    </section>
    <section class="rounded-2xl p-4" style="background: var(--surface); box-shadow: var(--shadow)">
      <div class="text-[12px]" style="color: var(--muted)">Ready accounts</div>
      <div class="mt-2 text-2xl font-semibold">{{ ready?.accounts_ready ?? "—" }}</div>
      <div class="text-[12px]" style="color: var(--muted)">
        {{ ready?.status === 503 ? "No usable account" : ready ? `HTTP ${ready.status}` : "—" }}
      </div>
    </section>
    <section class="rounded-2xl p-4" style="background: var(--surface); box-shadow: var(--shadow)">
      <div class="text-[12px]" style="color: var(--muted)">Pool</div>
      <div class="mt-2 text-2xl font-semibold">{{ pool?.accounts ?? "—" }}</div>
      <div class="text-[12px]" style="color: var(--muted)">
        {{ pool ? "from the gateway" : gateway.adminKey ? "Pool unavailable" : "Admin key required" }}
      </div>
    </section>
    <p v-if="problem" class="md:col-span-3 text-[13px]" style="color: var(--danger)">{{ problem }}</p>
    <p v-else-if="gateway.error" class="md:col-span-3 text-[13px]" style="color: var(--danger)">{{ gateway.error }}</p>
    <button type="button" class="w-fit rounded-lg px-3 py-2 text-[13px]" style="background: var(--accent); color: var(--accent-ink)" @click="load">
      Refresh
    </button>
  </div>
</template>
