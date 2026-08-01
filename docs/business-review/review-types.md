# Tipos de revisión

> Catálogo de **qué** puede revisar un rol cada semana. Cada rol declara en su MD qué tipo(s) usa. Añadir un tipo nuevo es editar este fichero y referenciarlo desde el MD del rol que lo necesite — sin tocar el workflow.

Cada tipo describe tres cosas:

- **Fuentes** — qué tiene que mirar el LLM para esta revisión.
- **Preguntas** — qué se debe preguntar mientras lo mira.
- **Evidencias** — qué adjuntar a la issue en el campo `evidence` para que un humano pueda verificarlo.

---

## `dashboards`

Revisión de los paneles que el negocio consulta para tomar decisiones operativas.

**Fuentes**:
- Página `/inicio` (panel fijo de "estado del negocio").
- Listado de paneles en `/paneles` y los paneles guardados accesibles desde ahí.
- Para cada panel: título, descripción, widgets, KPIs, gráficos, tablas y los valores actuales que muestran.
- La especificación JSON del panel (estructura, SQL subyacente) cuando esté accesible.

**Preguntas a plantear**:
- ¿Qué decisión se debería poder tomar mirando este panel? ¿Se puede?
- ¿Hay contexto comparativo (vs ayer, vs semana pasada, vs mes anterior, vs YoY, vs presupuesto)? Si no, ¿se puede saber si el dato actual es bueno o malo?
- ¿Los KPIs tienen unidades, divisa, periodo claros?
- ¿Hay un dato que parece anómalo (caída brusca, valor imposible, demasiado redondo)? ¿Está señalado?
- ¿El panel cubre el tema entero o deja un hueco evidente?
- ¿Hay redundancia (dos widgets diciendo lo mismo) o falta de jerarquía (lo importante mezclado con lo secundario)?
- ¿El panel es accionable? Si veo algo malo, ¿sé qué siguiente paso dar?

**Evidencias a adjuntar**:
- URL relativa del panel (p. ej. `/inicio`, `/paneles/<id>`).
- Nombre concreto del widget o KPI conflictivo.
- Valor actual que viste y por qué te llamó la atención.

---

## `data-quality`

Revisión de la fiabilidad de los datos que alimentan los paneles. No se trata de calidad de SQL, sino de **si los datos llegan a tiempo y completos** para que las decisiones sean fiables.

**Fuentes**:
- Tabla `etl_watermarks` (cuándo se sincronizó por última vez cada tabla).
- Tabla `etl_sync_runs` (errores recientes, duración, filas sincronizadas).
- Página `/etl` (Monitor ETL del dashboard) si es accesible.
- Tablas `ps_*` con un vistazo a `MAX(fecha)` o equivalente para ver si los datos llegan al día actual.
- Conteos por tienda / día para detectar gaps (días sin datos, tiendas sin datos).

**Preguntas a plantear**:
- ¿Hay datos del día anterior en las tablas críticas (`ps_ventas`, `ps_lineas_ventas`, `ps_stock_tienda`)?
- ¿Hay tablas con watermark muy antiguo sin razón aparente?
- ¿Hay errores recurrentes en `etl_sync_runs` que nadie está mirando?
- ¿Hay tiendas que dejaron de aportar datos?
- ¿Hay periodos con caídas inexplicadas en volumen sincronizado?
- Los paneles del negocio, ¿saben señalar cuando los datos están viejos?

**Evidencias a adjuntar**:
- Nombre de tabla y watermark observado.
- Número de error y fecha en `etl_sync_runs`.
- Diferencia entre `MAX(fecha)` esperado y real.

---

## `llm-telemetry`

Revisión del comportamiento del LLM dentro de la propia plataforma — qué pide la gente, qué falla, qué patrones se repiten.

**Fuentes**:
- Tabla `llm_tool_calls` (cada llamada agentic: tool, parámetros, duración, éxito).
- Tabla `llm_errors` (errores del proveedor LLM con su diagnóstico sanitizado).
- Tabla `llm_usage` (consumo por proveedor, coste estimado).
- Vista de admin `/admin/tool-calls` si es accesible.

**Preguntas a plantear**:
- ¿Qué tools fallan más? ¿Por qué (timeout, validación, datos)?
- ¿Hay prompts que generan patrones repetidos de fallo?
- ¿Hay paneles guardados cuyas SQL fallan al re-ejecutarse?
- ¿El gasto está concentrado en flujos que no aportan valor?
- ¿El usuario está reintentando muchas veces para conseguir lo mismo? Eso indica que el panel original no resolvía la pregunta.

**Evidencias a adjuntar**:
- Nombres de tool y conteo de fallos en los últimos 30 días.
- IDs de error específicos en `llm_errors`.
- Patrón observado y cuántas veces se repite.

---

## `documentation`

Revisión del drift entre lo que dicen las docs y lo que el negocio realmente necesita o ve hoy.

**Fuentes**:
- `AGENTS.md`, `ARCHITECTURE.md`, `DECISIONS.md` (+ `docs/decisions/`).
- `docs/skills/*.md` (skills relevantes para el negocio).
- `docs/architecture/*.md` (ER por dominio).

**Preguntas a plantear**:
- ¿Hay descripciones de paneles o KPIs en docs que ya no cuadran con lo que muestra la app?
- ¿Hay reglas de negocio documentadas que el negocio actual ya no aplica?
- ¿Hay decisiones (D-NNN) cuyo "Status" se ha quedado obsoleto?
- ¿Hay vacíos: temas que el negocio menciona pero que no están documentados (p. ej. cómo se calcula el "ticket medio")?

**Evidencias a adjuntar**:
- Ruta del fichero y línea/sección.
- Cita literal corta y por qué chirría.

---

## `codebase`

Revisión **de negocio** del código entregado recientemente — no calidad técnica, sino si lo que se ha entregado responde a lo que el negocio pidió.

**Fuentes**:
- PRs recientes (últimos 14 días) con label `business-review` ya cerradas.
- PRs recientes que tocan `dashboard/` o `etl/sync/`.
- Issues cerradas en el mismo periodo.

**Preguntas a plantear**:
- ¿Lo que se entregó responde realmente al problema descrito en la issue de negocio original?
- ¿Hay PRs cerrados que no han producido el cambio visible que prometían?
- ¿Hay desviación entre el "Resultado esperado" original y el resultado real?

**Evidencias a adjuntar**:
- Número de PR e issue origen.
- Diferencia concreta entre lo prometido y lo entregado.

---

## Cómo añadir un tipo nuevo

1. Añade una sección con el formato anterior en este fichero.
2. Referencia el slug nuevo desde el MD del rol que vaya a usarlo (`tipo_revision: <slug>`).
3. Listo. El workflow no necesita cambios — sólo lee qué tipo declara cada rol y le pasa al LLM la sección correspondiente.
