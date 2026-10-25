package expo.modules.splatcapture

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import java.net.Inet4Address
import java.net.InetAddress

/**
 * The Android twin of iOS's CameraStreamBrowser: finds the other phones' cameras on the Wi-Fi, the
 * `_rovercam._tcp` services that `CameraStreamServer` advertises, each resolved to an IPv4 address a
 * web view can load, leaving out the one whose id is `ownId` (this phone's own). In remote mode the
 * app shows the camera of the phone in mount mode, the one on the rover.
 */
class CameraStreamBrowser(context: Context, private val ownId: String) {
  data class Stream(val id: String?, val name: String, val device: String, val origin: String) {
    fun toMap(): Map<String, Any> = buildMap {
      put("name", name)
      put("device", device)
      put("origin", origin)
      id?.let { put("id", it) }
    }
  }

  /** Called with every stream found so far, whenever that changes (on the main thread). */
  var onChange: ((List<Stream>) -> Unit)? = null

  private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
  /** Everything here happens on the main thread, which NSD's callbacks are posted to. */
  private val main = Handler(Looper.getMainLooper())
  private var wanted = false
  private var discovery: NsdManager.DiscoveryListener? = null
  /** Advertised right now, by service name. */
  private val found = mutableSetOf<String>()
  /** Found and resolved, by service name. */
  private val streams = linkedMapOf<String, Stream>()
  /** NSD resolves one service at a time: the rest wait here. */
  private val queue = ArrayDeque<NsdServiceInfo>()
  private var resolving = false

  fun start() {
    main.post { browse() }
  }

  fun stop() {
    main.post {
      wanted = false
      discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
      discovery = null
      found.clear()
      queue.clear()
      if (streams.isNotEmpty()) {
        streams.clear()
        emit()
      }
    }
  }

  private fun browse() {
    wanted = true
    // Already looking: say what's been found, for a new listener.
    if (discovery != null) return emit()
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {}
      override fun onServiceFound(info: NsdServiceInfo) {
        main.post {
          found.add(info.serviceName)
          enqueue(info)
        }
      }
      override fun onServiceLost(info: NsdServiceInfo) {
        main.post {
          found.remove(info.serviceName)
          queue.removeAll { it.serviceName == info.serviceName }
          if (streams.remove(info.serviceName) != null) emit()
        }
      }
      override fun onStartDiscoveryFailed(serviceType: String, code: Int) {
        // Start over in a moment, as iOS does when its browser fails.
        main.post {
          if (discovery === this) discovery = null
          main.postDelayed({ if (wanted) browse() }, RETRY_MS)
        }
      }
      override fun onStopDiscoveryFailed(serviceType: String, code: Int) {}
    }
    discovery = listener
    nsd.discoverServices(CameraStreamServer.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
  }

  private fun enqueue(info: NsdServiceInfo) {
    if (info.serviceName !in found || streams.containsKey(info.serviceName)) return
    if (queue.none { it.serviceName == info.serviceName }) queue.addLast(info)
    resolveNext()
  }

  @Suppress("DEPRECATION")
  private fun resolveNext() {
    if (resolving) return
    val info = queue.removeFirstOrNull() ?: return
    resolving = true
    nsd.resolveService(info, object : NsdManager.ResolveListener {
      override fun onServiceResolved(resolved: NsdServiceInfo) {
        main.post {
          resolving = false
          add(resolved)
          resolveNext()
        }
      }

      override fun onResolveFailed(failed: NsdServiceInfo, code: Int) {
        main.post {
          resolving = false
          // Unreachable for now: try again in a moment, if it's still advertised.
          main.postDelayed({ enqueue(info) }, RETRY_MS)
          resolveNext()
        }
      }
    })
  }

  private fun add(info: NsdServiceInfo) {
    if (info.serviceName !in found) return
    val txt = info.attributes.mapValues { (_, value) -> value?.let { String(it) } ?: "" }
    if (txt["id"] == ownId) return
    val address = address(info) ?: return
    streams[info.serviceName] = Stream(
      id = txt["id"],
      name = info.serviceName,
      device = txt["device"] ?: info.serviceName,
      origin = "http://${address.hostAddress}:${info.port}",
    )
    emit()
  }

  /** IPv4, which a URL holds as it is (a link-local IPv6 address needs its interface too). */
  @Suppress("DEPRECATION")
  private fun address(info: NsdServiceInfo): InetAddress? {
    val addresses = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) info.hostAddresses else listOfNotNull(info.host)
    return addresses.firstOrNull { it is Inet4Address }
  }

  private fun emit() {
    onChange?.invoke(streams.values.sortedBy { it.name })
  }

  private companion object {
    const val RETRY_MS = 2000L
  }
}
