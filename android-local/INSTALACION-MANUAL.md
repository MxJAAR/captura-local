# Instalación manual en Android

## Archivos del ZIP

El ZIP debe contener una carpeta llamada `android-local` con estos archivos:

```text
android-local/
  index.html
  Code.gs
  server.cjs
  storage.cjs
  recover-admin.cjs
  stop-server.cjs
  control-server.cjs
  local-control.cjs
  install-shortcuts.cjs
  mdns-local.cjs
  package.json
  package-lock.json
  update.cjs
  update-config.json
  release.json
  verify-release.cjs
  node_modules/
  INSTALACION-MANUAL.md
```

No incluyas `data`, bases de datos, credenciales ni respaldos de otro teléfono. Los demás archivos del proyecto no son necesarios para esta instalación. Usa todos los archivos de la misma versión actualizada.

## 1. Extraer el ZIP

En el administrador de archivos de Android, extrae el ZIP en **Descargas**. Comprueba que `server.cjs` quede directamente en:

```text
Descargas/android-local/server.cjs
```

Evita una carpeta duplicada como `android-local/android-local`.

## 2. Preparar Termux

Abre Termux y espera a que termine la preparación inicial. Cuando aparezca `$`, ejecuta estos comandos uno por uno:

```bash
pkg update
pkg install nodejs-lts openssl libc++ net-tools
termux-setup-storage
```

Acepta las confirmaciones de instalación y el permiso de acceso al almacenamiento. Se necesita Internet para descargar los paquetes. `net-tools` proporciona `ifconfig` para el comando `IP`.

## 3. Copiar el programa

En una instalación nueva, ejecuta una sola vez:

```bash
cp -r ~/storage/downloads/android-local ~/captura-local
```

El nombre `android-local` debe coincidir exactamente con la carpeta extraída, respetando mayúsculas. La carpeta `~/captura-local` no debe existir antes de esta primera copia; estos pasos son para una instalación nueva.

## 4. Instalar los comandos y la dependencia de mDNS

```bash
node ~/captura-local/install-shortcuts.cjs
npm --prefix ~/captura-local ci --omit=dev --ignore-scripts
```

El instalador habilita los comandos desde cualquier carpeta de Termux. No es necesario escribir `cd` cada vez.
El ZIP oficial incluye `node_modules` con las dependencias: puedes omitir el comando `npm` si esa carpeta está presente. Si falta, ejecuta el comando con Internet. No es necesario repetirlo cada vez que enciendas el servidor.

## 5. Iniciar y consultar las credenciales

```bash
start
IniciarAdmin
```

`start` consulta la versión publicada en GitHub antes de iniciar. Si hay una nueva versión, verifica su firma y prueba su arranque con datos temporales antes de aplicarla. Conserva la base de datos, las capturas, los usuarios y las contraseñas de este teléfono. Si no hay Internet o falla la actualización, inicia la versión instalada. La consulta y descarga tienen un límite de 15 segundos; una actualización puede necesitar unos segundos adicionales para validarse. Si ya está activo, no actualiza: usa `stop` y después `start`.

`start` deja el servidor en segundo plano y devuelve la terminal. La primera ejecución crea una base vacía, el usuario `admin`, una contraseña aleatoria de **8 caracteres** y una CaptureKey propia.

`IniciarAdmin` muestra el archivo `acceso-inicial.txt`: usuario, contraseña inicial y CaptureKey inicial. No inicia una sesión ni cambia la contraseña. Después de cambiar el acceso, ese archivo sigue mostrando los valores iniciales.

## 6. Abrir la página

En el navegador del mismo teléfono abre:

```text
http://127.0.0.1:8080
```

Entra a **Administración** con las credenciales iniciales, agrega líneas y rutas y, si lo deseas, cambia tu usuario o contraseña en **Cuenta del administrador**. Las nuevas contraseñas admiten de **6 a 128 caracteres**.

## 7. Configurar y comprobar el nombre local mDNS

**La configuración ya viene incluida en los archivos.** `server.cjs` activa `mdns-local.cjs`, y `package.json` junto con `package-lock.json` indican qué dependencia instala el comando `npm` del paso 4. No necesitas editar routers, archivos hosts ni configurar un DNS en los otros dispositivos.

1. Conecta el Android servidor y el dispositivo que abrirá la página a la misma red local. El servidor anuncia el nombre por la interfaz Wi-Fi `wlan0`; esta configuración no anuncia por datos móviles.
2. Si ya ejecutaste `start` en el paso 5, el anuncio también está iniciado. Si no, ejecuta `start`.
3. Espera unos segundos y abre esta dirección completa desde el otro dispositivo:

   ```text
   http://captura.local:8080
   ```

4. Comprueba que aparezca la página de captura. Para comprobar solo la respuesta del servidor puedes abrir:

   ```text
   http://captura.local:8080/health
   ```

   Debe mostrar `{"ok":true,"storage":"sqlite"}`.

`start` activa el servidor y mDNS; `stop` detiene ambos. **No ejecutes `node mdns.cjs` ni otro anuncio por separado.** Una vez descargadas las dependencias, el anuncio no necesita Internet. El servidor revisa los cambios de IP del Wi-Fi cada cinco segundos; el navegador puede conservar la dirección anterior durante unos 30 segundos.

Cuando el nombre funcione, usa siempre `http://captura.local:8080` para conservar el mismo origen del navegador. Las sesiones y los pendientes que se hayan guardado entrando por una IP o por `127.0.0.1` no se trasladan automáticamente al nombre local; termina de enviar esos pendientes antes de cambiar de dirección.

### Si `captura.local` no abre

Ejecuta en Termux:

```bash
status
tail -n 30 ~/captura-local/server.log
```

Busca una línea parecida a `mDNS: captura.local -> 192.168.1.25`. Esa IP es un ejemplo; la tuya puede ser distinta. El anuncio en el registro confirma que el servidor lo está emitiendo, pero la prueba desde el otro dispositivo es la que confirma que la red y el cliente permiten usarlo.

- Si aparece **mDNS no disponible**, ejecuta `stop`, repite el comando `npm` del paso 4 y ejecuta `start`.
- Si no hay dirección Wi-Fi o aparece **esperando Wi-Fi**, conecta el teléfono a Wi-Fi. Esta versión requiere que su interfaz se llame `wlan0`.
- Si aparece **ya pertenece a otro equipo**, hay otro dispositivo anunciando `captura.local`. No uses dos servidores con ese mismo nombre en la misma red; detén el anuncio duplicado y reinicia el servidor con `stop` y `start`.
- Si el registro muestra el anuncio pero el nombre no abre, ejecuta `IP` y prueba `http://DIRECCION_IP:8080`. Si la IP funciona y el nombre no, el problema está en la resolución mDNS del cliente o en el paso de multicast por la red. Si tampoco funciona por IP, comprueba la comunicación entre los dispositivos.

Las redes empresariales pueden bloquear multicast o aislar a sus clientes. El servidor no puede eliminar esas restricciones. `captura.local` es un nombre de red local, no un dominio accesible desde Internet.

## Comandos diarios

Respeta las mayúsculas indicadas:

| Comando | Función |
|---|---|
| `start` | Enciende el servidor. Si ya está activo, no inicia otra copia. |
| `stop` | Apaga el servidor y conserva los datos. |
| `status` | Indica si el servidor está activo o detenido. |
| `IniciarAdmin` | Muestra las credenciales iniciales. |
| `RecuperarAdmin` | Restablece el administrador sin pedir la contraseña anterior. |
| `IP` | Ejecuta `ifconfig` para mostrar las interfaces y sus direcciones. |

Para recuperar al administrador, ejecuta `RecuperarAdmin`, conserva o cambia el usuario, introduce dos veces la nueva contraseña y escribe `SI` para guardar. La contraseña no aparece mientras escribes. Se cierran las sesiones administrativas; se conservan las capturas y la CaptureKey.

Para conectar otros dispositivos en la misma red, ejecuta `IP` y busca la dirección `inet` de Wi-Fi, normalmente en `wlan0`. Abre `http://DIRECCION_IP:8080` desde los otros equipos. No uses `127.0.0.1` en otro dispositivo para acceder a este servidor. Android puede restringir parte de la información de red que muestra `ifconfig`.

Para apagar usa `stop`: cerrar Termux o pulsar Ctrl+C en una terminal libre no detiene necesariamente el servidor en segundo plano.

**Uso posterior:** si apagas o reinicias el teléfono en algún momento, abre Termux y escribe `start` para volver a encender el servidor. No necesitas reinstalar nada. Reiniciar el teléfono no es un paso de esta instalación.
