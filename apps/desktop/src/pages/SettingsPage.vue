<script setup lang="ts">
import { ref } from "vue";
import { useGateway } from "../stores/gateway.ts";

const gateway = useGateway();
const remote = ref<Record<string, any> | null>(null);
const message = ref("");

function save() {
  gateway.saveKeys();
  message.value = "Saved on this machine.";
}

async function loadRemote() {
  remote.value = await gateway.request("/admin/dash/settings");
}
</script>

<template>
  <div class="mx-auto flex max-w-xl flex-col gap-4">
    <form class="flex flex-col gap-3 rounded-2xl p-4" style="background: var(--surface); box-shadow: var(--shadow)" @submit.prevent="save">
      <label class="text-[12px]" style="color: var(--muted)">Gateway URL
        <input v-model="gateway.base" class="mt-1 w-full rounded-lg px-3 py-2 text-[13px]" style="background: var(--surface-2)" />
      </label>
      <label class="text-[12px]" style="color: var(--muted)">Admin key
        <input v-model="gateway.adminKey" type="password" autocomplete="off" class="mt-1 w-full rounded-lg px-3 py-2 text-[13px]" style="background: var(--surface-2)" />
      </label>
      <label class="text-[12px]" style="color: var(--muted)">Client key
        <input v-model="gateway.clientKey" type="password" autocomplete="off" class="mt-1 w-full rounded-lg px-3 py-2 text-[13px]" style="background: var(--surface-2)" />
      </label>
      <button class="w-fit rounded-lg px-3 py-2 text-[13px]" style="background: var(--accent); color: var(--accent-ink)" type="submit">Save</button>
      <p v-if="message" class="text-[12px]" style="color: var(--ok)">{{ message }}</p>
    </form>
    <section class="rounded-2xl p-4 text-[13px]" style="background: var(--surface); box-shadow: var(--shadow)">
      <h2 class="font-medium">Account generation</h2>
      <p class="mt-2" style="color: var(--muted)">
        Automated signup, CAPTCHA solving, and promotional credit claims are not in this rewrite.
        Import a snapshot of an account you own, or use device login when that flow is available.
      </p>
      <button type="button" class="mt-3 rounded-lg px-3 py-2 text-[13px]" style="background: var(--surface-2)" @click="loadRemote">Load gateway settings</button>
      <dl v-if="remote" class="mt-3 grid grid-cols-2 gap-2">
        <dt style="color: var(--muted)">Listen</dt>
        <dd>{{ remote.host }}:{{ remote.port }}</dd>
        <dt style="color: var(--muted)">Strategy</dt>
        <dd>{{ remote.strategy }}</dd>
        <dt style="color: var(--muted)">Admin hint</dt>
        <dd>{{ remote.admin_key_hint }}</dd>
      </dl>
      <p v-if="gateway.error" class="mt-2" style="color: var(--danger)">{{ gateway.error }}</p>
    </section>
  </div>
</template>
