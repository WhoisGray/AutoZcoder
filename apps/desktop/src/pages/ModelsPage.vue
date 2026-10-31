<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGateway } from "../stores/gateway.ts";

const gateway = useGateway();
const models = ref<any[]>([]);

onMounted(async () => {
  if (!gateway.clientKey && !gateway.adminKey) return;
  try {
    const data = await gateway.request("/v1/models", { admin: false });
    models.value = data.data ?? [];
  } catch {
    if (gateway.adminKey) {
      const data = await gateway.request("/v1/models");
      models.value = data.data ?? [];
    }
  }
});
</script>

<template>
  <div class="overflow-auto rounded-2xl" style="background: var(--surface); box-shadow: var(--shadow)">
    <table class="w-full border-collapse text-left text-[13px]">
      <thead>
        <tr style="color: var(--muted)">
          <th class="px-4 py-3 font-medium">Model</th>
          <th class="px-4 py-3 font-medium">Context</th>
          <th class="px-4 py-3 font-medium">Max output</th>
          <th class="px-4 py-3 font-medium">Vision</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="models.length === 0">
          <td class="px-4 py-6" colspan="4" style="color: var(--muted)">
            {{ gateway.error ? gateway.error : "Set a client or admin key in Settings, then reopen this page." }}
          </td>
        </tr>
        <tr v-for="model in models" :key="model.id" class="border-t" style="border-color: var(--line)">
          <td class="px-4 py-3">{{ model.id }}</td>
          <td class="px-4 py-3 tabular-nums">{{ model.context_window ?? model.alias_of ?? "—" }}</td>
          <td class="px-4 py-3 tabular-nums">{{ model.max_output_tokens ?? "—" }}</td>
          <td class="px-4 py-3">{{ model.vision ? "Yes" : "—" }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="gateway.error" class="px-4 py-3 text-[13px]" style="color: var(--danger)">{{ gateway.error }}</p>
  </div>
</template>
