package expo.modules.splatcapture

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.json.JSONObject

/**
 * The Android twin of iOS's CameraStreamServer: serves the phone's camera to browsers and phones on the
 * same Wi-Fi, so the web app's live mode and a phone in remote mode can show what the rover sees. The
 * same plain HTTP routes, all with `Access-Control-Allow-Origin: *`:
 *
 * - `GET /camera.mjpg`: the live picture as MJPEG (`multipart/x-mixed-replace`);
 * - `GET /frame.jpg`: the newest frame once (503 before the first);
 * - `GET /status`: JSON `{ id, device, recording, viewers, frames, width, height }`;
 * - `GET /detections`: detection boxes as newline-delimited JSON (none come on Android, which has no
 *   detector, but the web app may open it).
 *
 * It advertises itself with NSD (Bonjour) as `_rovercam._tcp`, its TXT record carrying `id`, `device`
 * and `path` as on iOS. `SplatCaptureView` hands it frames while `wantsFrames`.
 */
class CameraStreamServer(context: Context) {
  private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val device: String = Build.MODEL

  /** Stays the same for this install, as on iOS: in the TXT record and `/status`. */
  val id: String = context.getSharedPreferences("splat-capture", Context.MODE_PRIVATE).let { preferences ->
    preferences.getString(ID_KEY, null) ?: UUID.randomUUID().toString().also {
      preferences.edit().putString(ID_KEY, it).apply()
    }
  }

  private var socket: ServerSocket? = null
  private var registration: NsdManager.RegistrationListener? = null
  private val clients = ConcurrentHashMap.newKeySet<Socket>()
  private val viewers = AtomicInteger(0)
  private var state = "stopped"
  private var error: String? = null
  private var port = 0

  /** Guards the newest frame and detections; waited on by the viewers for the next. */
  private val lock = Object()
  private var latest: ByteArray? = null
  private var width = 0
  private var height = 0
  private var frames = 0L
  private var latestDetections: String? = null
  private var detectionsCount = 0L

  /** True while at least one viewer has `/camera.mjpg` open. */
  val wantsFrames: Boolean get() = viewers.get() > 0

  /** Starts listening on `port`. Restarts if already running. */
  @Synchronized
  fun start(port: Int) {
    stop()
    state = "starting"
    error = null
    try {
      val socket = ServerSocket().apply {
        reuseAddress = true
        bind(InetSocketAddress(port))
      }
      this.socket = socket
      this.port = socket.localPort
      state = "ready"
      thread(name = "camera-stream-accept", isDaemon = true) { acceptLoop(socket) }
      advertise(socket.localPort)
    } catch (e: IOException) {
      state = "failed"
      error = e.message ?: e.toString()
    }
  }

  @Synchronized
  fun stop() {
    registration?.let { runCatching { nsd.unregisterService(it) } }
    registration = null
    socket?.let { runCatching { it.close() } }
    socket = null
    clients.forEach { runCatching { it.close() } }
    clients.clear()
    synchronized(lock) { lock.notifyAll() }
    state = "stopped"
  }

  /** For `cameraStreamStatus`, shaped like iOS's. */
  @Synchronized
  fun status(): Map<String, Any?> {
    val status = mutableMapOf<String, Any?>("state" to state, "viewers" to viewers.get())
    if (state == "ready") {
      status["port"] = port
      status["urls"] = localAddresses().map { "http://$it:$port" }
    }
    error?.let { status["error"] = it }
    return status
  }

  /** A new camera frame, upright: kept for `/frame.jpg` and sent to every viewer. */
  fun publish(jpeg: ByteArray, width: Int, height: Int) {
    synchronized(lock) {
      latest = jpeg
      this.width = width
      this.height = height
      frames++
      lock.notifyAll()
    }
  }

  /** The detector's newest boxes, as one line of JSON, for `/detections` viewers. */
  fun publishDetections(json: String) {
    synchronized(lock) {
      latestDetections = json
      detectionsCount++
      lock.notifyAll()
    }
  }

  private fun advertise(port: Int) {
    val info = NsdServiceInfo().apply {
      serviceName = "Rover camera ($device)"
      serviceType = SERVICE_TYPE
      setPort(port)
      setAttribute("device", device)
      setAttribute("id", id)
      setAttribute("path", "/camera.mjpg")
    }
    val listener = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) {}
      override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) {
        error = "Couldn't advertise on the Wi-Fi (NSD error $code)"
      }
      override fun onServiceUnregistered(info: NsdServiceInfo) {}
      override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) {}
    }
    registration = listener
    nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
  }

  private fun acceptLoop(socket: ServerSocket) {
    while (!socket.isClosed) {
      val client = try {
        socket.accept()
      } catch (e: IOException) {
        break
      }
      clients.add(client)
      thread(name = "camera-stream-client", isDaemon = true) {
        try {
          handle(client)
        } catch (_: IOException) {
          // The viewer went away.
        } finally {
          clients.remove(client)
          runCatching { client.close() }
        }
      }
    }
  }

  private fun handle(client: Socket) {
    client.tcpNoDelay = true
    val input = client.getInputStream().bufferedReader(Charsets.ISO_8859_1)
    val request = input.readLine() ?: return
    // The headers don't matter here.
    while (true) {
      val line = input.readLine() ?: break
      if (line.isEmpty()) break
    }
    val parts = request.split(" ")
    val method = parts.getOrNull(0) ?: ""
    val path = (parts.getOrNull(1) ?: "/").substringBefore('?')
    val out = BufferedOutputStream(client.getOutputStream())
    when {
      method == "OPTIONS" -> respond(out, 204, "text/plain", ByteArray(0))
      path == "/camera.mjpg" -> stream(client, out)
      path == "/detections" -> streamDetections(client, out)
      path == "/frame.jpg" -> {
        val jpeg = synchronized(lock) { latest }
        if (jpeg != null) respond(out, 200, "image/jpeg", jpeg)
        else respond(out, 503, "text/plain", "No frame yet".toByteArray())
      }
      path == "/status" -> respond(out, 200, "application/json", statusJson().toByteArray())
      else -> respond(out, 404, "text/plain", "Not found".toByteArray())
    }
  }

  private fun stream(client: Socket, out: OutputStream) {
    viewers.incrementAndGet()
    try {
      out.write("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=$BOUNDARY\r\n$COMMON\r\n".toByteArray())
      out.flush()
      var sent = -1L
      while (!client.isClosed) {
        val jpeg = synchronized(lock) {
          if (frames == sent) lock.wait(1000)
          if (frames == sent) null else latest.also { sent = frames }
        } ?: continue
        out.write("--$BOUNDARY\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.size}\r\n\r\n".toByteArray())
        out.write(jpeg)
        out.write("\r\n".toByteArray())
        out.flush()
      }
    } finally {
      viewers.decrementAndGet()
    }
  }

  private fun streamDetections(client: Socket, out: OutputStream) {
    out.write("HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n$COMMON\r\n".toByteArray())
    out.flush()
    var sent = -1L
    while (!client.isClosed) {
      val line = synchronized(lock) {
        if (detectionsCount == sent) lock.wait(1000)
        if (detectionsCount == sent) null else latestDetections.also { sent = detectionsCount }
      } ?: continue
      out.write("$line\n".toByteArray())
      out.flush()
    }
  }

  private fun statusJson(): String = synchronized(lock) {
    JSONObject()
      .put("id", id)
      .put("device", device)
      .put("recording", false)
      .put("viewers", viewers.get())
      .put("frames", frames)
      .put("width", width)
      .put("height", height)
      .toString()
  }

  private fun respond(out: OutputStream, status: Int, contentType: String, body: ByteArray) {
    val reason = when (status) {
      200 -> "OK"
      204 -> "No Content"
      404 -> "Not Found"
      else -> "Service Unavailable"
    }
    out.write("HTTP/1.1 $status $reason\r\nContent-Type: $contentType\r\nContent-Length: ${body.size}\r\n$COMMON\r\n".toByteArray())
    out.write(body)
    out.flush()
  }

  companion object {
    const val SERVICE_TYPE = "_rovercam._tcp"
    private const val ID_KEY = "cameraStreamId"
    private const val BOUNDARY = "frame"
    private const val COMMON = "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n"

    /** This phone's IPv4 addresses, Wi-Fi first. */
    fun localAddresses(): List<String> =
      NetworkInterface.getNetworkInterfaces().toList()
        .filter { it.isUp && !it.isLoopback }
        .sortedBy { if (it.name.startsWith("wlan")) 0 else 1 }
        .flatMap { network -> network.inetAddresses.toList().filterIsInstance<Inet4Address>() }
        .map { it.hostAddress ?: "" }
        .filter { it.isNotEmpty() }
  }
}
