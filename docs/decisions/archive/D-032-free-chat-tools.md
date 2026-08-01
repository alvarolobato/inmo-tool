---
id: D-032
title: Free-chat is inspección + handoff, no write tools
date: 2026-05-15
---

# D-032: Free-chat is inspección + handoff, no write tools

*Decided: 2026-05-15*

**Context**: Issue #616. La nueva pantalla de conversaciones libre (`context_kind='global'`, `mode='chat'`) da al LLM acceso al runner agentic para consultar datos y dashboards. El riesgo es que el modelo modifique dashboards directamente desde el chat libre, sin que el usuario haya indicado explícitamente que está en modo Modificar.

**Decision**: `FREE_CHAT_TOOLS` expone las 10 herramientas de inspección + `start_dashboard_generation` + `set_title` (12 total). `set_title` es la única herramienta de escritura permitida en free-chat: escribe únicamente el campo `title` de la conversación actual, usando `AND title IS NULL` para garantizar idempotencia. Las herramientas de escritura de dashboards (`apply_dashboard_modification`, `submit_dashboard_analysis`) están registradas en `FULL_DASHBOARD_TOOLS` (catálogo completo, para uso futuro) pero **no incluidas** en `FREE_CHAT_TOOLS`. Cuando el usuario pide un dashboard nuevo desde el chat libre, el LLM llama `start_dashboard_generation`, que crea el dashboard y ejecuta `POST /api/conversations/:id/handoff-to-dashboard` para mutar la conversación a `mode='modify'`. El usuario recibe un enlace en el chat (`/dashboard/:newId?continue=:convId`) y al navegar allí `ChatSidebar` carga la conversación preexistente en la pestaña Modificar, con todo el historial del free-chat visible.

**Alternatives rejected**:
- **Exponer `apply_dashboard_modification` en free-chat directamente**: el modelo podría modificar un dashboard en respuesta a una pregunta casual ("¿cómo sería este panel con ventas semanales?") sin que el usuario lo aprobase explícitamente.
- **Conversación separada para el flujo post-handoff**: requeriría duplicar el historial o mostrar dos conversaciones distintas al usuario. El modelo de conversación única es más coherente y no necesita cambios de schema.
- **No tener free-chat en absoluto**: eliminaba el caso de uso de "chat sobre datos antes de construir un panel", que es el camino de descubrimiento más natural para usuarios no técnicos.

**Rationale**: El write-through directo desde free-chat aumentaría el riesgo de modificaciones accidentales en dashboards de producción. El handoff redirige al flujo Modificar existente, donde las herramientas de escritura están correctamente encapsuladas y el usuario tiene plena visibilidad del cambio que se va a aplicar. Los mensajes del free-chat y el `initial_context` original se preservan como auditoría inmutable; la conversación es un único hilo continuo aunque el `mode` haya cambiado.

**See**: `dashboard/lib/llm-tools/catalog.ts` (`FREE_CHAT_TOOLS`, `FULL_DASHBOARD_TOOLS`), `dashboard/lib/llm-tools/handlers/start-dashboard-generation.ts`, `dashboard/app/api/conversations/[id]/handoff-to-dashboard/route.ts`, `dashboard/lib/conversation-context.ts` (`buildFreeChatContext()`) — all planned, implementation tracked in issue #616.
