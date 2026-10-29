# Publicar una actualización desde esta computadora

Repositorio: https://github.com/MxJAAR/captura-local

1. Edita los archivos del programa. Si editas el `Index.html` original o las plantillas administrativas, ejecuta `node android-local/build.cjs` para regenerar la versión local.
2. Incrementa el entero `version` en `android-local/release.json`. Nunca reutilices una versión publicada.
3. Ejecuta `node android-local/build-release.cjs` y `node android-local/update-test.cjs` desde la raíz del proyecto. Ejecuta también las pruebas correspondientes al cambio.
4. En PowerShell crea el ZIP: `Compress-Archive -Path android-local/dist/android-local -DestinationPath android-local/dist/android-local.zip -Force`.
5. Publica los tres archivos de `android-local/dist`: `version.json`, `update.json`, `android-local.zip`, en una Release nueva cuyo tag sea `v` seguido del entero, por ejemplo `v2`. Márcala como la última versión estable; no como prerelease. No reemplaces paquetes publicados.

Los teléfonos consultan `https://github.com/MxJAAR/captura-local/releases/latest/download/version.json` al ejecutar `start`. Cada manifiesto apunta al paquete de su propia versión. La instalación manual se descarga siempre desde `https://github.com/MxJAAR/captura-local/releases/latest/download/android-local.zip`.

La clave privada está en `android-local/tools/release-private/signing-key.pem`. Consérvala para publicar versiones posteriores: NO la subas al repositorio, no la envíes a los teléfonos y no la incluyas en ZIP. El empaquetador selecciona explícitamente los archivos permitidos y únicamente incorpora la clave pública. Los datos de cada centro nunca forman parte del paquete.

Una instalación antigua necesita incorporar el actualizador una sola vez; después bastan `stop` y `start`. La actualización automática no hace migraciones destructivas de datos. Cualquier futura modificación del formato de la base debe mantener compatibilidad con la versión anterior para permitir restaurarla.
