# Branch changes paginado con arquitectura de diffs unificada

Fecha: 2026-08-11

Estado: implementado en cinco commits locales sobre `main`.

## Objetivo

Eliminar el corte agregado de 120.000 bytes de **Branch changes** y hacer que todos sus archivos
sean alcanzables desde la pestaña Diff sin cargar, transportar ni parsear el patch completo de una
vez.

La solución reutiliza el modelo que ya funciona en los diffs de PR:

```text
scope estable
  -> slice de archivos completos
  -> cursor opaco
  -> siguiente slice al acercarse al final
  -> nextCursor = null cuando el diff está completo
```

La unificación se hará en el límite correcto:

- un contrato compartido para una página de diff;
- una máquina de estado compartida para acumular/reemplazar páginas;
- adquisición específica por proveedor: API remota para PR y Git local para Branch changes;
- renderers específicos por superficie: Pierre en web/desktop y el renderer nativo en mobile.

No se intentará convertir `PullRequestCodeTab`, `DiffPanel` y `ReviewSheet` en un único componente.
Comparten el protocolo y las invariantes, no la composición visual.

## Resultado esperado

- El primer contenido de Branch changes aparece rápido.
- Al acercarse al final se carga automáticamente el siguiente grupo de archivos.
- Ningún límite agregado elimina silenciosamente los archivos posteriores.
- Una página termina siempre entre archivos; jamás en medio de un hunk.
- `nextCursor` expresa que faltan páginas. `truncated` queda reservado para contenido de un archivo
  que Git o la política de seguridad no pudo inlinear, igual que en PR.
- Las estadísticas del header representan el diff completo, no sólo las páginas cargadas.
- Web y Desktop comparten el comportamiento mediante `DiffPanel`.
- Mobile puede recorrer el mismo Branch changes completo sin concatenar y reparsear todas las
  páginas en cada carga.
- Un cliente o servidor anterior sigue funcionando con el preview legado de 120 KB y su aviso de
  truncamiento; no se rompe el uso remoto durante version skew.

## Estado actual

### Branch changes

`ReviewDiffPreviewInput` pide un preview completo y `ReviewDiffPreviewResult` devuelve dos sources:
Working tree y Branch range. Cada source contiene un único string `diff`.

El driver ejecuta:

```text
git diff --patch --minimal <baseRef>...HEAD
```

con `REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES = 120_000`. Al superar el límite, conserva un prefijo
arbitrario, marca `truncated: true` y el último archivo puede quedar incompleto. Los archivos que
venían después desaparecen de la respuesta. `DiffPanel` parsea ese único string y calcula desde él
las estadísticas, por lo que el contador también pasa a ser parcial.

### Diffs de PR

`PullRequestDiffResult` ya distingue:

```ts
{
  patch: string;
  truncated: boolean;
  nextCursor: string | null;
}
```

Cada slice contiene archivos completos. `PullRequestCodeTab` conserva las páginas por separado,
parsea una sola vez cada página y usa un sentinel dentro del scroll virtualizado para pedir la
siguiente. Una página reemplazada invalida las posteriores porque sus cursores pertenecían a la
versión anterior.

Hoy esa máquina de estado está implementada localmente dentro de `PullRequestCodeTab`; Branch
changes y mobile no pueden reutilizarla.

## Alcance

Este cambio migra:

- el contrato base de slices;
- el acumulador de slices usado por PR;
- Branch changes en web/desktop;
- Branch changes en mobile;
- el servidor Git que sirve Branch changes;
- documentación de usuario e interna.

Quedan fuera deliberadamente:

- **Working tree**: es mutable entre páginas e incluye untracked. Necesita decidir si se congela un
  snapshot o si cada cambio invalida toda la lectura. No debe fingir las garantías de dos commits
  inmutables.
- **Turn diffs/checkpoints**: sus refs son estables y pueden migrarse después, pero hoy usan otro
  contrato y un límite de 10 MB. No son necesarios para resolver este paper cut.
- **Git commit tabs**: también son candidatos futuros, pero no deben ampliar esta entrega.
- eliminar todos los límites por archivo: una sola modificación patológica debe poder declararse
  no inlineable sin impedir que carguen los archivos siguientes.

La arquitectura compartida se diseñará para admitir esos scopes después, sin agregar caminos que
no tengan un consumidor en esta entrega.

## Decisiones de arquitectura

### 1. Slice es una unidad de transporte, no un string acumulado

El contrato común será equivalente a:

```ts
interface DiffSliceResult {
  readonly patch: string;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

interface LoadedDiffSlice extends DiffSliceResult {
  readonly cursor: string | null;
}
```

`PullRequestDiffResult` reutilizará este schema/tipo. El source paginado de Review expondrá los
mismos tres campos, manteniendo `diff` como nombre legado del patch durante la compatibilidad de
protocolo si renombrarlo exige romper clientes anteriores.

No se concatenan patches. Cada slice conserva su propia identidad, parse y cache key.

### 2. Estado compartido, queries específicas

Crear una utilidad pura en `packages/client-runtime` con operaciones para:

- crear/resetear estado por `scopeKey`;
- registrar el cursor solicitado;
- insertar una respuesta nueva;
- reemplazar una página que cambió y descartar todas las posteriores;
- ignorar respuestas tardías de otro scope;
- detectar cursores repetidos para no entrar en loops;
- obtener `nextCursor`, páginas cargadas y estado completo.

PR y Review usarán este mismo reducer. Los hooks/atoms que ejecutan RPC seguirán siendo propios de
cada feature porque sus inputs y políticas de refresh no son iguales.

### 3. Snapshot estable para Branch changes

La primera petición paginada resolverá nombres humanos a objetos inmutables:

```text
headCommit      = rev-parse HEAD^{commit}
mergeBaseCommit = merge-base <baseRef> <headCommit>
snapshotId      = hash(mergeBaseCommit, headCommit, ignoreWhitespace)
```

El cursor opaco llevará versión, snapshot y offset suficiente para continuar sin depender de que
la branch o su base sigan apuntando al mismo lugar. Los SHAs se decodifican y validan como Git
object IDs antes de usarlos; los paths siempre se entregan como argumentos posteriores a `--`.

Si el usuario refresca, cambia base, cambia `ignoreWhitespace` o termina un turn que mueve HEAD, el
cliente crea un scope nuevo y empieza desde la primera página. Las respuestas tardías del snapshot
anterior no se mezclan.

### 4. Manifest liviano y páginas por archivos completos

El servidor obtiene primero un manifest NUL-separated de los archivos entre los dos commits. Debe
conservar suficiente información para additions, deletions, rename, add, delete y binary, incluso
con espacios, tabs o saltos de línea en nombres válidos de Git.

El manifest se pagina en orden estable. Una página comienza con un máximo inicial de 100 archivos,
en línea con PR. Para producirla se ejecuta `git diff` contra los SHAs congelados y sólo con los
paths de esa página; en renames se incluyen los paths anterior y nuevo para no degradar su
detección.

El límite deja de aplicarse al diff agregado. Sigue existiendo un presupuesto defensivo por
respuesta:

- si un batch excede el presupuesto, se divide y se reintenta con menos archivos;
- si un único archivo excede el presupuesto, se devuelve su metadata/header sin cortar un hunk,
  se marca la página como `truncated` y el cursor continúa después de ese archivo;
- ese caso no puede ocultar todos los archivos posteriores.

Así se elimina el fallo actual —un prefijo arbitrario de todo el branch— sin convertir una única
respuesta WebSocket en memoria ilimitada.

### 5. `nextCursor` y `truncated` significan cosas distintas

- `nextCursor !== null`: hay más archivos completos disponibles; no es una advertencia.
- `truncated === true`: esta página contiene al menos un archivo cuyo patch no pudo inlinearse
  completo, por ejemplo binario o archivo individual demasiado grande.
- `nextCursor === null && truncated === false`: el diff quedó completamente disponible.

La UI no mostrará “diff incompleto” sólo porque aún está cargando páginas. Mostrará progreso y un
footer de carga. La advertencia amarilla se reserva para contenido realmente omitido.

### 6. Estadísticas globales separadas del patch cargado

El source paginado incluirá metadata global obtenida desde el manifest/numstat:

```ts
{
  fileCount: number;
  additions: number;
  deletions: number;
}
```

El header seguirá mostrando el total correcto desde la primera página. Para entradas binarias,
Git reporta `-`; no se inventan líneas. Mientras haya páginas pendientes se puede mostrar además
`loadedFiles / fileCount`, sin reemplazar `+A -D` por estadísticas parciales.

### 7. Compatibilidad cliente-servidor

No se sustituirá abruptamente el RPC existente. `ReviewDiffPreviewInput` recibirá una petición
opcional y explícita de paginación, con `sourceKind` y cursor opcional.

- Cliente nuevo + servidor nuevo: envía la señal paginada desde la primera página.
- Cliente nuevo + servidor viejo: el servidor ignora el campo desconocido y devuelve el preview
  legado sin `nextCursor`; el cliente lo trata como una única página legacy y conserva el aviso si
  vino truncada.
- Cliente viejo + servidor nuevo: al no enviar la señal paginada, el servidor conserva exactamente
  el camino legado de 120 KB.

Los campos nuevos de respuesta serán opcionales donde lo requiera el decode compatible. La ruta
paginada nueva siempre los devuelve. Esto mantiene Desktop, web remoto y mobile utilizables durante
una actualización despareja.

### 8. Carga y errores

Web/desktop:

- el footer del `AnnotatableCodeView` aloja un sentinel, igual que el visor de PR;
- un `IntersectionObserver` pide la página siguiente antes de llegar al final;
- mientras carga, las páginas existentes siguen utilizables;
- si falla una página posterior, el observer se desarma y aparece Retry al final, no un error que
  sustituya el diff ya visible.

Mobile:

- no se agregará un segundo scroll encima del renderer nativo;
- `onVisibleFileChange` compara el archivo visible con los últimos archivos cargados;
- al entrar en el umbral final solicita el siguiente cursor;
- las páginas se parsean/cachean individualmente y luego se aplanan como archivos/rows para el
  bridge nativo;
- una respuesta tardía de otra sección o thread no modifica la selección actual.

Refresh en ambas superficies vacía las páginas del scope, pide la primera y mantiene las reglas
actuales de foco, pull-to-refresh, cambio de base y fin de turn.

## Plan por commits

### ✅ Commit 1 — `refactor(diff): share paged slice state`

Objetivo: extraer la parte realmente común del visor de PR sin cambiar su comportamiento.

Cambios:

- Añadir un schema/tipo común de `DiffSliceResult` en contracts y hacer que
  `PullRequestDiffResult` lo reutilice sin alterar su wire shape.
- Añadir en `packages/client-runtime` el reducer puro de páginas y sus selectores.
- Migrar `PullRequestCodeTab` desde su `sliceState` ad hoc al reducer compartido.
- Mantener intactos cursor, refresh, parse por slice, invalidación de páginas posteriores, sentinel,
  comentarios y commits del PR.

Pruebas:

- contrato encode/decode conserva `{ patch, truncated, nextCursor }`;
- append de páginas en orden;
- reemplazo de una página elimina las posteriores;
- respuesta de scope anterior se ignora;
- cursor repetido no genera otra petición;
- tests enfocados existentes de `PullRequestCodeTab`/PR siguen verdes.

Este commit debe ser estrictamente behavior-preserving. Si la extracción exige cambiar la UI de
PR, el límite compartido fue elegido demasiado arriba.

### ✅ Commit 2 — `feat(review): page branch diffs by complete files`

Objetivo: ofrecer slices estables de Branch changes desde el servidor, conservando el RPC legado.

Cambios:

- Extender `packages/contracts/src/review.ts` con:
  - solicitud opcional de paginación;
  - `sourceKind` paginado;
  - cursor opaco;
  - `nextCursor`, `snapshotId` y estadísticas globales compatibles.
- Actualizar tipos IPC/RPC sin crear una segunda autoridad para el diff.
- Implementar en `GitVcsDriverCore`:
  - resolución de head y merge base a SHAs;
  - manifest NUL-separated;
  - encode/decode validado del cursor;
  - slicing estable por archivos;
  - reducción adaptativa del batch cuando excede el presupuesto;
  - header/metadata y `truncated` para un único archivo no inlineable;
  - `nextCursor` hasta consumir el manifest.
- Mantener el camino existente cuando el request no opta a paginación.
- Hacer que `ReviewService` siga validando `cwd` antes de decodificar/ejecutar cualquier cursor.

Pruebas enfocadas en `GitVcsDriverCore.test.ts`, `ReviewService.test.ts` y `server.test.ts`:

- más de una página devuelve todos los archivos una sola vez;
- ninguna página termina con un archivo/hunk cortado;
- add, delete, rename, binary y nombres extraños sobreviven el manifest;
- `ignoreWhitespace` forma parte de la identidad y del comando de cada página;
- mover HEAD o base después de la primera página no mezcla snapshots;
- cursor inválido, manipulado o de otro scope falla de forma tipada;
- un batch grande se subdivide;
- un solo archivo enorme no bloquea los siguientes;
- request legado conserva el límite y `truncated` actuales;
- autorización y restricción al workspace no cambian.

### ✅ Commit 3 — `feat(web): load branch diff slices incrementally`

Objetivo: activar la ruta paginada en `DiffPanel`, que cubre web y Desktop.

Cambios:

- Pedir Branch changes por scope desde la primera página; no volver a calcular también Working tree
  en cada continuación.
- Acumular páginas con el reducer compartido y keyear el scope por environment, cwd, base elegida,
  HEAD/snapshot e `ignoreWhitespace`.
- Parsear cada patch una sola vez con una cache key que incluya snapshot y cursor.
- Aplanar los archivos renderables sin concatenar ni reparsear patches anteriores.
- Conservar collapse/reopen, scroll recordado, selección de líneas, comentarios, cambio de base,
  stacked/split, wrap y expansión de contexto.
- Agregar sentinel, indicador de carga y Retry al footer del mismo scroll virtualizado.
- Usar estadísticas globales para `+A -D`; mostrar progreso de archivos cuando aporte información.
- Interpretar ausencia de campos paginados como respuesta legacy y mantener allí el banner actual
  de 120 KB.
- Refrescar desde página uno al enfocar, completar un turn o cambiar opciones, sin mezclar respuestas
  anteriores.

Pruebas:

- extraer la reconciliación de páginas/archivos a lógica testeable, en vez de montar todo
  `DiffPanel` para cada caso;
- primera página rápida y segunda añadida sin duplicados;
- cambiar base/whitespace descarta páginas previas;
- fallo tardío conserva lo cargado y Retry usa el mismo cursor;
- refresh empieza en cursor nulo;
- stats no disminuyen/aumentan al cargar páginas;
- fallback con servidor antiguo conserva el aviso de truncamiento;
- collapse y scroll usan IDs de archivo estables a través de nuevas páginas.

### ✅ Commit 4 — `feat(mobile): page branch review diffs incrementally`

Objetivo: mantener paridad móvil sin concatenar todo el patch ni modificar innecesariamente los
módulos nativos.

Cambios:

- Adaptar `useReviewSections` y `reviewState` para conservar slices por sección/snapshot.
- Parsear/cachear cada slice de Branch changes por separado en `reviewModel` y aplanar los archivos
  antes de construir rows nativas.
- Usar `onVisibleFileChange` como señal de prefetch al acercarse a los últimos archivos.
- Mantener pull-to-refresh, selección de sección/archivo, collapsed/viewed files, comentarios,
  highlighting visible y prewarming.
- Mostrar carga/reintento sin borrar las páginas visibles.
- Mantener el preview legacy y su notice cuando el servidor conectado no soporte paginación.

Sólo si `onVisibleFileChange` resulta insuficiente después de las pruebas se añadirá un evento
`onEndReached` al módulo iOS/Android. No se modifica código nativo por anticipado.

Pruebas:

- estado por environment/thread/section no mezcla páginas;
- parse incremental conserva orden, stats, file IDs y comment targets;
- visible-file threshold pide una única continuación;
- cambio de sección y refresh cancelan lógicamente respuestas tardías;
- error de página posterior conserva rows existentes;
- fallback legacy sigue mostrando truncamiento parcial.

### ✅ Commit 5 — `docs(review): document progressive branch diffs`

Objetivo: cerrar semántica, documentación y limpieza sin mezclar nuevas funcionalidades.

Cambios:

- Documentar en `docs/user/source-control.md` que Branch changes carga archivos progresivamente y
  que el warning significa contenido individual omitido, no páginas pendientes.
- Añadir una nota interna corta sobre el protocolo de slices, snapshot/cursor, version skew y la
  separación entre `nextCursor` y `truncated`.
- Eliminar código/banners exclusivos del cap agregado sólo donde la ruta paginada los vuelva
  inalcanzables; conservar fallback legado mientras se soporte version skew.
- Auditar nombres para que PR y Review usen `slice`, `cursor`, `nextCursor`, `snapshot` y
  `truncated` con el mismo significado.

Verificación final enfocada:

- `git diff --check`;
- búsqueda exacta de usos de `REVIEW_DIFF_PATCH_MAX_OUTPUT_BYTES`, previews concatenados y mensajes
  que confundan paginación con truncamiento;
- tests tocados de contracts, client-runtime, PR, ReviewService, GitVcsDriverCore, web y mobile;
- typecheck sólo de contracts, client-runtime, server, web, desktop y mobile;
- no ejecutar checks repo-wide.

## Invariantes de aceptación

### Completitud

- Un branch con más de 120 KB y más de una página permite llegar a su último archivo.
- La unión de paths de todas las páginas coincide con el manifest inicial, salvo entradas marcadas
  explícitamente como no inlineables.
- No hay archivos duplicados ni perdidos en el límite entre páginas.

### Consistencia

- Todas las páginas pertenecen al mismo par inmutable merge-base/head.
- Cambiar base, HEAD o whitespace reinicia el scope.
- Refresh nunca concatena una primera página nueva con continuaciones viejas.

### Rendimiento

- El tiempo al primer diff depende de una página, no del patch completo.
- Añadir una página parsea sólo esa página.
- El payload WebSocket queda acotado por página.
- El renderer conserva virtualización y no introduce animaciones/repaints continuos.

### UX

- Las estadísticas son globales.
- Hay feedback de carga y Retry al final sin tapar lo ya leído.
- Collapse, scroll, selección/comentarios y expansión de contexto siguen funcionando.
- Desktop, web local/remoto y mobile observan la misma disponibilidad eventual del diff completo.

### Compatibilidad

- Cliente nuevo con servidor viejo conserva el preview actual.
- Cliente viejo con servidor nuevo conserva el preview actual.
- Los cursores no permiten escapar del cwd autorizado ni inyectar argumentos Git.

## Verificación integrada

Después de integrar los commits y pasar las pruebas enfocadas, hacer una sola pasada real con un
fixture que tenga:

- más de 100 archivos;
- más de 120 KB de patch;
- rename, add, delete y binario;
- al menos un archivo individual que active la política no-inlineable;
- un commit nuevo mientras una página posterior está pendiente.

Comprobar en web/Desktop que el último archivo aparece, que los stats no cambian durante la carga,
que refresh no mezcla snapshots y que Retry no borra lo ya visible. Repetir la navegación esencial
en mobile.

Por las reglas del repositorio, antes de abrir browser/computer use, iOS Simulator o Android
Emulator durante la implementación se pedirá autorización. El plan en sí no lanza ninguna de esas
superficies.

## Riesgos y mitigaciones

- **Rename detectado distinto al filtrar por paths.** Incluir ambos paths y probar explícitamente
  los límites de página; si Git no conserva la identidad, producir cada rename como unidad propia.
- **Un archivo domina el presupuesto.** No cortar su patch: devolver representación estructurable,
  marcar `truncated` y continuar el cursor.
- **Cursores stale.** Llevar SHAs y versión en el cursor, validar todo y keyear el cliente por
  snapshot.
- **Version skew remoto.** Opt-in explícito y campos opcionales; el camino sin opt-in sigue legado.
- **Reparse O(n²).** Nunca concatenar páginas; cache por snapshot+cursor en web y mobile.
- **Refactor demasiado amplio.** Compartir reducer y schema, no renderers ni adquisición de datos.
- **Working tree mezclado accidentalmente.** Mantenerlo fuera del opt-in paginado en esta entrega y
  dejar tests que aseguren que conserva el flujo existente.

## Continuación posible

Una vez estabilizado Branch changes, el orden razonable de migración es:

1. turn/checkpoint diffs, porque comparan refs inmutables;
2. git commit tabs, por la misma razón;
3. Working tree, sólo después de decidir una política explícita de snapshot mutable;
4. retirar el fallback legado cuando el rango de version skew soportado lo permita.

Esas migraciones deben reutilizar el contrato y reducer creados aquí, pero cada una merece su propia
vertical y sus propias pruebas de identidad.
