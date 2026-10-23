/* Dev-only entry for /ui-preview.html. Not part of the production bundle. */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { Preview } from './Preview'

const style = document.createElement('style')
style.textContent = `
  .pv-stage { position: fixed; inset: 0; background: radial-gradient(circle at 50% 50%, #0b1b2c 0 1px, transparent 2px) 0 0 / 46px 46px, var(--ink); }
  .pv-earth { position: absolute; left: 50%; top: 50%; width: min(56vh, 56vw); aspect-ratio: 1; transform: translate(-50%, -50%); border-radius: 50%; background: #10324f; box-shadow: inset -40px -20px 80px #020a14; }
  .pv-sat { position: absolute; width: 12px; height: 12px; padding: 0; border: 0; border-radius: 50%; transform: translate(-50%, -50%); }
`
document.head.appendChild(style)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
)
