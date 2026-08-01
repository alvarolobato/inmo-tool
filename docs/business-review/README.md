# Revisión semanal de negocio por roles simulados

Sistema de prompts para que un LLM, una vez por semana, simule a 7 perfiles distintos del negocio y proponga **una mejora** desde el ángulo de cada uno. Las propuestas se materializan como issues en GitHub que la AI Factory triagea/planifica pero **no ejecuta** hasta que un humano apruebe.

> Issue origen: #467.

## Estructura

| Fichero | Qué es |
|---------|--------|
| [common.md](common.md) | Instrucciones compartidas: tono, formato de salida, qué NO hacer, etiquetas, idioma. Se concatena con cada rol antes de cada llamada al LLM. |
| [review-types.md](review-types.md) | Catálogo extensible de **tipos de revisión** (dashboards, data_quality, llm_telemetry, documentation, codebase). Cada rol declara cuál(es) usa. |
| [roles/01-ceo.md](roles/01-ceo.md) | Dirección General — visión estratégica pan-negocio. |
| [roles/02-retail.md](roles/02-retail.md) | Dirección Comercial Retail — tiendas, vendedores, ranking accionable. |
| [roles/03-mayorista.md](roles/03-mayorista.md) | Dirección Mayorista B2B — clientes B2B, pedidos, churn. |
| [roles/04-compras.md](roles/04-compras.md) | Dirección de Compras — proveedores, cobertura, rotura/exceso. |
| [roles/05-cfo.md](roles/05-cfo.md) | CFO / Controller — margen real, devoluciones, descuentos, riesgo. |
| [roles/06-producto.md](roles/06-producto.md) | Dirección de Producto — surtido, familias, tallas (34 slots). |
| [roles/07-bi-skeptic.md](roles/07-bi-skeptic.md) | Analista crítico — calidad, gaps, KPIs sin contexto, paneles que engañan. |

## Cómo se ejecuta

Pendiente de implementar (tareas 4-6 de la issue #467). Resumen del diseño:

- GitHub Action semanal (lunes 06:00 UTC) + `workflow_dispatch` con `dry_run`.
- Para cada rol: concatena `common.md` + secciones relevantes de `review-types.md` + el MD del rol → llama al LLM → recibe JSON → crea issue (o `skip`).
- **Tope: 1 issue por rol y por semana** → máx 7/semana.
- Etiquetas en cada issue creada: `business-review`, `role:<slug>`, `review-type:<slug>`, `needs-human-approval`. **Sin** `ai-work` hasta que un humano apruebe.
- Deduplicación por `fingerprint`: si ya existe issue abierta del mismo rol con mismo fingerprint, se añade comentario en lugar de crear duplicada.

## Cómo añadir/modificar

| Cambio | Qué editar |
|--------|------------|
| Cambiar foco de un rol | El MD del rol (`roles/0N-*.md`). |
| Añadir un 8º rol | Nuevo MD `roles/08-*.md` + alta en el listado del workflow. |
| Añadir un nuevo tipo de revisión | Nueva sección en `review-types.md` + referenciar `tipo_revision: <slug>` desde el rol que la use. |
| Cambiar el formato de salida | `common.md` (afecta a todos los roles). |
| Cambiar tono / reglas globales | `common.md`. |

## Aprobar la ejecución de una propuesta

1. Revisar la issue creada por el rol.
2. Si tiene sentido: retirar `needs-human-approval`, añadir `ai-work`. La AI Factory recogerá la issue para triage técnico y planning.
3. Si no tiene sentido: cerrar la issue con `state_reason: not_planned` y comentar el motivo (sirve de feedback para refinar el MD del rol).
