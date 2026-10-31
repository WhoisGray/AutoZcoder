<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGateway } from "../stores/gateway.ts";

const gateway = useGateway();
const stats = ref<Record<string, any> | null>(null);

onMounted(() => {
  if (gateway.adminKey) gateway.request("/admin/stats").then((data) => (stats.value = data)).catch(() => undefined);
});
</script>

<template>
  <div class="grid gap-4 md:grid-cols-4">
    <section v-for="card in [
      ['Requests', stats?.requests ?? '—'],
      ['Tokens', stats?.total_tokens ?? '—'],
      ['OK', stats?.ok ?? '—'],
      ['Rate limited', stats?.rate_limited ?? '—'],
    ]" :key="card[0]" class="rounded-2xl p-4" style="background: var(--surface); box-shadow: var(--shadow)">
      <div class="text-[12px]" style="color: var(--muted)">{{ card[0] }}</div>
      <div class="mt-2 text-2xl font-semibold tabular-nums">{{ card[1] }}</div>
    </section>
    <p v-if="!gateway.adminKey" class="md:col-span-4 text-[13px]" style="color: var(--muted)">Admin key required.</p>
    <p v-else-if="stats && stats.requests === 0" class="md:col-span-4 text-[13px]" style="color: var(--muted)">No usage yet.</p>
    <p v-if="gateway.error" class="md:col-span-4 text-[13px]" style="color: var(--danger)">{{ gateway.error }}</p>
  </div>
</template>
