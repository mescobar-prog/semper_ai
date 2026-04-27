<script setup lang="ts">
import { ref, onMounted } from 'vue'

const status = ref<string>('loading...')

onMounted(async () => {
  try {
    const res = await fetch(`${import.meta.env.VITE_API_BASE}/health`)
    status.value = JSON.stringify(await res.json())
  } catch (e) {
    status.value = `error: ${e}`
  }
})
</script>

<template>
  <main>
    <h1>semper_ai</h1>
    <p>API health: {{ status }}</p>
  </main>
</template>
