<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useGateway } from "../stores/gateway.ts";

const gateway = useGateway();
const accounts = ref<any[]>([]);
const form = ref({ account_id: "", email: "", access_token: "" });

async function load() {
  const data = await gateway.request("/admin/accounts");
  accounts.value = data.accounts ?? [];
}

async function add() {
  await gateway.request("/admin/accounts", { body: { ...form.value } });
  form.value = { account_id: "", email: "", access_token: "" };
  await load();
}

async function remove(id: string) {
  await gateway.request(`/admin/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  await load();
}

onMounted(() => {
  if (gateway.adminKey) load().catch(() => undefined);
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <p v-if="!gateway.adminKey" class="text-[13px]" style="color: var(--muted)">Add the admin key in Settings to manage accounts.</p>
    <form class="grid gap-2 rounded-2xl p-4 md:grid-cols-4" style="background: var(--surface); box-shadow: var(--shadow)" @submit.prevent="add">
      <input v-model="form.account_id" class="rounded-lg px-3 py-2 text-[13px]" style="background: var(--surface-2)" placeholder="Account id" />
      <input v-model="form.email" class="rounded-lg px-3 py-2 text-[13px]" style="background: var(--surface-2)" placeholder="Email" />
      <input v-model="form.access_token" type="password" class="rounded-lg px-3 py-2 text-[13px]" style="background: var(--surface-2)" placeholder="Access token" autocomplete="off" />
      <button class="rounded-lg px-3 py-2 text-[13px]" style="background: var(--accent); color: var(--accent-ink)" type="submit">Import</button>
    </form>
    <div class="overflow-auto rounded-2xl" style="background: var(--surface); box-shadow: var(--shadow)">
      <table class="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr style="color: var(--muted)">
            <th class="px-4 py-3 font-medium">Email</th>
            <th class="px-4 py-3 font-medium">State</th>
            <th class="px-4 py-3 font-medium">In flight</th>
            <th class="px-4 py-3 font-medium">Token</th>
            <th class="px-4 py-3 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="accounts.length === 0">
            <td class="px-4 py-6" colspan="5" style="color: var(--muted)">No accounts loaded.</td>
          </tr>
          <tr v-for="account in accounts" :key="account.id" class="border-t" style="border-color: var(--line)">
            <td class="px-4 py-3">{{ account.email || account.id }}</td>
            <td class="px-4 py-3">{{ account.state }}</td>
            <td class="px-4 py-3 tabular-nums">{{ account.in_flight }}</td>
            <td class="px-4 py-3 tabular-nums">{{ account.token_hint }}</td>
            <td class="px-4 py-3 text-right">
              <button type="button" class="text-[12px]" style="color: var(--danger)" @click="remove(account.id)">Remove</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="gateway.error" class="text-[13px]" style="color: var(--danger)">{{ gateway.error }}</p>
  </div>
</template>
