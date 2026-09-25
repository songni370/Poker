import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import 'primeicons/primeicons.css'
import './styles/theme.css'
import App from './App.vue'
import router from './router.ts'

const app = createApp(App)
app.config.errorHandler = (err, instance, info) => {
  console.error('*** VUE ERROR HANDLER ***', err, info, instance)
}

app
  .use(createPinia())
  .use(router)
  .use(PrimeVue, {
    ripple: true,
    theme: {
      preset: Aura,
      options: {
        // 深色由 src/client/styles/theme.css 中的令牌覆盖统一负责，这里关闭 PrimeVue 自带的深浅切换。
        darkModeSelector: 'none',
        cssLayer: false,
      },
    },
  })
  .mount('#app')
