## Release <!-- Escribir version: v2.4.0 -->

### Descripcion de cambios
<!-- Describir los cambios incluidos en esta release -->

-
-
-

### Tipo de cambio
- [ ] Feature (nueva funcionalidad)
- [ ] Bugfix (correccion de error)
- [ ] Hotfix (correccion critica en produccion)
- [ ] Refactor (mejora sin cambio funcional)

### Deploy programado

<!--
  OBLIGATORIO: Configurar fecha/hora y tipo de aplicacion.

  Formato fecha: YYYY-MM-DDTHH:MM:SS+01:00 (hora España CET)
  Ejemplo: 2026-02-20T22:00:00+01:00 = 20 de febrero a las 22:00h

  Si NO quieres programar y prefieres deploy manual, elimina la linea DEPLOY_SCHEDULED.
-->

DEPLOY_SCHEDULED: 2026-02-20T22:00:00+01:00
TYPEAPP: both

<!--
  TYPEAPP opciones:
    - frontend  → solo frontend
    - backend   → solo backend
    - both      → frontend + backend (por defecto)
-->

### Checklist pre-release
- [ ] Tests pasan en CI
- [ ] Code review aprobado
- [ ] Rama creada desde `develop` (release) o `main-promocion-pro` (hotfix)
- [ ] Nombre de rama correcto: `release/vX.Y.Z` o `hotfix/vX.Y.Z`
- [ ] Fecha y hora de deploy configurada arriba
- [ ] TYPEAPP configurado correctamente

### Notas adicionales
<!-- Cualquier informacion relevante para el deploy -->

