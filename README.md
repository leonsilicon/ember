<p align="center"><img src="assets/ember-mark.svg" alt="Ember logo" width="120"></p>

# Ember

A wildfire-prevention rover with a phone for its brain.

## Inspiration

We wanted to work on what happens before a wildfire: the dry leaves, pine needles, and other fine fuel that accumulate on the ground around homes. Keeping that ground clear takes repeated work, especially when the leaves keep falling. We saw an opportunity for a small rover that could find fallen leaves and gather them into a designated pile.

A phone already has much of what that rover needs: a camera, motion tracking, powerful on-device inference, and, on some models, LiDAR. We wanted to put those sensors to work together rather than build a separate perception system from scratch.

That became Ember: a rover prototype, a mobile app that understands the ground in front of it, and a web platform that connects that local view to 3D reconstructions and wildfire hazard data.

## What it does

Ember connects five parts of the prevention workflow:

- **Find leaves.** The mounted iPhone detects fallen leaves in its camera feed, shows their distance when depth is available, and places repeated sightings on a persistent local map. Depth checks help reject detections on walls, furniture, or other surfaces above the ground.
- **Plan the clearing job.** The autopilot selects confirmed leaves within a work circle, checks the space ahead, and plans approaches and detours. Its collection logic covers lining up, scooping, returning to the pile, dumping, and retrying missed leaves.
- **Operate the rover.** The browser dashboard drives the rover over Wi-Fi, with controls for the wheels and pan/lift servos. The mobile app also implements a Bluetooth motor-control path and a second-phone remote mode with the mounted phone's camera streamed over Wi-Fi. A live top-down view shows the phone's leaf and obstacle map.
- **Reconstruct the site.** Record a walk or rover pass, watch a live 3D preview take shape, and turn the capture into an explorable Gaussian splat. Captures retain the camera poses and geometry needed to reconstruct the scene.
- **Explore wildfire exposure.** An Ontario map brings together forest fuel types, buildings, seasonal canopy change, and fire-weather readings. Users can inspect nearby hazards and run experimental fire-spread scenarios to compare clearing and other mitigation actions.

The full collection cycle runs in the simulator using the same navigation code as the phone. The current rover firmware exposes wheel and pan/lift servo controls; connecting those controls to the autonomous scoop-and-dump sequence is the next integration step.

## How we built it

**The mobile app.** We built the app with Expo, React Native, and TypeScript, with custom native modules in Swift and Kotlin. On iPhone, Swift gives us ARKit camera tracking, per-frame camera intrinsics, and LiDAR depth where supported. Phones without LiDAR can still record reconstruction datasets using ARKit's tracked feature points. Android currently supports CameraX camera streaming, local phone discovery, and the mount/remote workflow; AR recording and leaf detection are currently implemented on iOS.

**On-device perception.** We use OWL-ViT, an open-vocabulary object detector, with text queries for dead leaves, brown leaves, and leaf piles. Our export pipeline precomputes those text embeddings and packages the image detector as an ExecuTorch model with Core ML delegation. The app runs it through `react-native-executorch`, so leaf inference happens on the phone without sending frames to a cloud model. We smooth detections across frames, combine them with camera pose and depth, and require repeated sightings before a leaf becomes a navigation target.

**The rover's brain and hardware.** The navigation system is pure TypeScript shared by the phone and browser simulator. It remembers leaves in world coordinates, fits the ground from LiDAR, keeps a short-term memory of obstacles, and evaluates clear driving corridors. This lets it steer toward a leaf even after that leaf leaves the camera frame. Tracking loss and stale depth stop the phone's autopilot. We implemented ESP32 motor-control firmware over Bluetooth Low Energy for the mobile app; the rover's current V7 firmware uses an HTTP API for wheels and pan/lift servos, driven by the web dashboard through a local proxy. Both firmware paths stop wheel motion if commands stop arriving.

**3D reconstruction.** Our native capture module selects frames as the phone moves and saves images, camera transforms, intrinsics, and a seed point cloud in a Nerfstudio-compatible dataset. The app uploads that capture to Vercel Blob; an Upstash Redis queue hands it to a Bun agent on a Mac, which trains the Gaussian splat with Brush and publishes intermediate previews. Because the phone already records camera poses, this path skips estimating them from scratch with COLMAP. We also have a separate COLMAP/OpenSplat pipeline for ordinary photo folders. Live 3D provides a point-cloud reconstruction while recording; the trained Gaussian splat follows through the capture pipeline.

**The web platform and wildfire data.** The Next.js app runs on Vercel, with Three.js and Gaussian-splat viewers for 3D scenes and MapLibre for the wildfire map. A Python geospatial pipeline combines Ontario's forest-fuel raster with Overture building footprints and roads, then measures hazardous fuel near each building. Sentinel-2 imagery provides a seasonal canopy-greenness change layer, while Canadian Wildland Fire Information System readings and Open-Meteo wind data add current conditions. A browser worker runs a simplified Canadian Forest Fire Behavior Prediction model so users can compare simulated outcomes with and without interventions. The exposure scores are screening heuristics, and the scenarios are exploratory models.

## Challenges we ran into

Matthew, our team's hardware guy, flew all the way from Paris with the equipment and tools we needed to build the rover during the hackathon. A few missing parts turned that into a logistics challenge too: we made a trip to the Aurora Public Library to 3D-print replacements and called on a teammate's parent who lived nearby to buy RC wheels right before the store closed. Hardware development has a way of making your critical path very literal.

Getting a leaf box on the screen was only the beginning. Detections flicker, brown objects look like leaves, and the target eventually drops below the camera as the rover approaches it. We had to separate perception from driving: confirm sightings over time, place them in a stable coordinate system, and navigate using the phone's pose. LiDAR added another useful check by telling us whether a detection was actually on the ground.

Reconstruction brought its own geometry problems. Image orientation, camera coordinates, depth, and the viewer all have to agree. Sparse feature points from a phone without LiDAR also need different training settings from a dense seed cloud. We built checks around the capture geometry and adjusted splat growth so those sparse captures could develop into useful scenes.

## Accomplishments that we're proud of

- Building phone-based perception, spatial navigation, and ESP32 motor-control paths in one project.
- Exporting and embedding an open-vocabulary leaf detector for on-device inference.
- Reusing the rover's actual navigation code in a simulator with noisy detections, obstacles, missed scoops, and repeatable test scenarios.
- Connecting native capture, background uploads, queued training, and browser viewing into one Gaussian-splat workflow, including capture on iPhones without LiDAR.
- Bringing regional hazard screening and interactive fire scenarios into the same platform as the rover controls and 3D views.
- Making progress on physical hardware while solving a few very physical supply-chain problems along the way.

## What we learned

Hardware is hard and time-consuming. A missing wheel or bracket can block a whole system, so mechanical planning and access to spare parts matter as much as the software plan.

We also learned that a detector alone is not a navigation system. Remembering where something was seen, checking its geometry, and knowing when to stop are essential parts of turning a prediction into movement. Sharing the brain between simulation and the phone gave us a way to exercise those decisions before trying them on the rover.

Working across satellite data and phone cameras taught us to respect what each sensor can tell us. A satellite can show canopy change across a region; the rover's camera and depth sensors inspect individual objects on the ground. Connecting those scales is useful, but validating them requires different evidence.

## What's next for Ember

Our first priority is to finish integrating the scoop and dump mechanism, then validate complete collection runs outdoors on uneven ground. We want to measure what the rover actually clears, how often it misses leaves, and how reliably it avoids obstacles under changing light and terrain.

We also want to collect and label footage from the rover's own camera height to improve leaf detection, extend AR capture and perception to Android, and add site histories that compare coverage and ground-fuel build-up over time. On the map side, we want to expand geographic coverage and evaluate the screening and fire-spread models against independent observations.

The goal is to make repeated fuel-clearing work easier to carry out and easier to inspect, with evidence from the ground to guide what happens next.

## Built with

Expo · React Native · TypeScript · Swift · Kotlin · ARKit · CameraX · LiDAR · OWL-ViT · ExecuTorch · Core ML · ESP32 · Bluetooth Low Energy · Next.js · Vercel · Bun · Upstash Redis · Vercel Blob · Brush · COLMAP · OpenSplat · Three.js · MapLibre · Python · Sentinel-2

## Try it out

- [Ember web app](https://soon2026.vercel.app) — team sign-in required.
- [Development guide](development.md) — the original README, including setup, architecture, rover internals, and implementation limits.
- [Setup and run guide](SETUP.md) — instructions for running the components.
