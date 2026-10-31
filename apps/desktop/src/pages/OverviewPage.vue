<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGateway } from "../stores/gateway.ts";

const gateway = useGateway();
const health = ref<Record<string, unknown> | null>(null);
const ready = ref<Record<string, unknown> | null>(null);
const pool = ref<Record<string, any> | null>(null);

async function load() {
  health.value = await fetch(`${gateway.base}/health`).then((response) => response.json());
  ready.value = await fetch(`${gateway.base}/ready`).then(async (response) => ({ status: response.status, ...(await response.json()) }));
  if (gateway.adminKey) pool.value = await gateway.request("/admin/pool/state");
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
      <div class="text-[12px]" style="color: var(--muted)">HTTP {{ ready?.status ?? "—" }}</div>
    </section>
    <section class="rounded-2xl p-4" style="background: var(--surface); box-shadow: var(--shadow)">
      <div class="text-[12px]" style="color: var(--muted)">Pool</div>
      <div class="mt-2 text-2xl font-semibold">{{ pool?.accounts ?? "—" }}</div>
      <div class="text-[12px]" style="color: var(--muted)">{{ pool ? "from the gateway" : "add an admin key in Settings" }}</div>
    </section>
    <p v-if="gateway.error" class="md:col-span-3 text-[13px]" style="color: var(--danger)">{{ gateway.error }}</p>
    <button type="button" class="w-fit rounded-lg px-3 py-2 text-[13px]" style="background: var(--accent); color: var(--accent-ink)" @click="load">
      Refresh
    </button>
  </div>
</template>
