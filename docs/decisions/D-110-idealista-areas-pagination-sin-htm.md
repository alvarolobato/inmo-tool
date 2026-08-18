---
id: D-110
title: Idealista pagina las búsquedas /areas/ sin `.htm`
date: 2026-08-18
group: Data / connectors
rule: 'Idealista tiene DOS familias de paginación: la normal usa `/pagina-N.htm` y la de polígono (`/areas/...?shape=`) usa `/pagina-N` SIN extensión — la forma `.htm` devuelve su página de error aunque la página exista. Va por config (`pagination.extensionlessPathPrefixes`), nunca en el constructor.'
---

# D-110: Idealista pagina las búsquedas `/areas/` sin `.htm`

**Estado**: ACEPTADA · **Fecha**: 18-ago-2026 · **Contexto**: captura guiada (extensión)

## Problema

La caminata de enumeración construía SIEMPRE `/pagina-<n>.htm`. En una búsqueda
por polígono (`/areas/...?shape=((…))`) esa URL devuelve la página de error de
idealista ("la dirección que has introducido no corresponde a ninguna página"),
así que la captura se quedaba en la página 1 sin decir por qué.

## Qué se comprobó, y por qué no fue lo que parecía

El primer síntoma sugería "esta búsqueda no tiene página 2". Era falso: Álvaro
reprodujo el fallo en una búsqueda que **sí** tiene página 2, y navegando a mano
el propio idealista enlaza a

```
/areas/venta-viviendas/con-precio-hasta_250000,precio-desde_80000/pagina-2?shape=((…))
```

es decir, **sin `.htm`**. Son dos familias de URL distintas:

| Búsqueda | Página 2 |
|---|---|
| Normal (`/venta-viviendas/sevilla-sevilla/`) | `/pagina-2.htm` |
| Polígono (`/areas/venta-viviendas/<filtros>/`) | `/pagina-2` |

El esquema original se verificó en su día contra `robots.txt`, que solo declara
la familia `.htm` (`Disallow: /*/pagina-*.htm`) — por eso parecía completo. En
el mismo fichero `/areas/` aparece como familia aparte (`Disallow: /areas/`),
que en retrospectiva era la pista de que no comparten esquema.

## Decisión

`pagination` pasa a llevar `extensionlessPathPrefixes: ["/areas/"]` en la config
de idealista, y `resultsPageUrl` omite el `.htm` cuando el path empieza por uno
de esos prefijos. Sigue siendo dirigido por datos: otro portal con la misma
peculiaridad se resuelve en su config, sin tocar el constructor.

El regex que limpia el segmento existente acepta ahora las dos formas, así que
página→1 sigue devolviendo la URL canónica y la caminata puede leer el número de
página de vuelta (`currentResultsPage`), que es de lo que depende su guarda de
"no he avanzado".

## Consecuencias

- Dos tests fijaban el comportamiento incorrecto (`/areas/…/pagina-2.htm` como
  resultado esperado). **El bug estaba blindado por su propia suite**: se
  escribieron al arreglar el caso de `/mapa-google` (#506), donde lo que se
  comprobaba era que el segmento del mapa desapareciera, y el `.htm` se copió
  sin cuestionarlo. Corregidos, no borrados.
- Queda una arista distinta y menor: en la ÚLTIMA página de cualquier búsqueda,
  `nextResultsUrl` fabrica la siguiente a ciegas (no consulta el DOM), así que
  la caminata siempre gasta una carga de más antes de parar por "0 enlaces
  nuevos". No rompe nada ni pierde datos. Arreglarlo pide preferir el ancla real
  del DOM sobre el esquema limpio, que es un cambio de comportamiento para todos
  los portales y merece su propia issue.
- `/multi/` (que `observe-search-url.js` ya trata como familia de búsqueda de
  idealista, aunque `isListingPath` todavía no) es candidato natural a la misma
  peculiaridad. Si algún día se le da soporte de listado, **compruébalo, no lo
  supongas**. Lo mismo para las rutas con prefijo de idioma (`/en/areas/…`), que
  hoy la extensión no reconoce en absoluto.
- `robots.txt` de idealista prohíbe `/areas/` a los rastreadores. Aquí navega la
  extensión en el navegador del propio dueño sobre una búsqueda que él ha
  fijado, no un crawler de servidor, pero conviene tenerlo presente al decidir
  hasta dónde automatizar esta ruta.
