"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type RoomViewerProps = {
  flytoPill: boolean;
  pillDetected: boolean;
};

// Hardcoded medication anchor (locked).
const MEDICATION_POSITION = new THREE.Vector3(2.834, -1.579, 1.159);
const DOOR_CAM_POSITION = new THREE.Vector3(-2.8, -1.1, 3.6);
const DOOR_CAM_TARGET = new THREE.Vector3(0.4, -1.2, 1.7);

const OVERVIEW_CAM_POSITION = new THREE.Vector3(0, 3, 6);
const OVERVIEW_CAM_TARGET = new THREE.Vector3(0, 0, 0);

function getPillCameraPosition(): THREE.Vector3 {
  return new THREE.Vector3(MEDICATION_POSITION.x, MEDICATION_POSITION.y + 0.8, MEDICATION_POSITION.z + 1.4);
}

function getWalkEndCameraPosition(): THREE.Vector3 {
  return new THREE.Vector3(MEDICATION_POSITION.x, MEDICATION_POSITION.y + 0.28, MEDICATION_POSITION.z + 0.62);
}

type FlythroughState = {
  active: boolean;
  phase: "flyto" | "return" | "walkto";
  startPos: THREE.Vector3;
  startTarget: THREE.Vector3;
  endPos: THREE.Vector3;
  endTarget: THREE.Vector3;
  startTime: number;
  duration: number;
};

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((entry) => entry.dispose());
    return;
  }
  material.dispose();
}

export default function RoomViewer({ flytoPill, pillDetected }: RoomViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const pillPinRef = useRef<THREE.Group<THREE.Object3DEventMap> | null>(null);
  const flythroughRef = useRef<FlythroughState | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const startFlythrough = useCallback((targetCamPos: THREE.Vector3, targetLookAt: THREE.Vector3) => {
    if (!cameraRef.current || !controlsRef.current) {
      return;
    }

    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    controlsRef.current.enabled = false;
    flythroughRef.current = {
      active: true,
      phase: "flyto",
      startPos: cameraRef.current.position.clone(),
      startTarget: controlsRef.current.target.clone(),
      endPos: targetCamPos.clone(),
      endTarget: targetLookAt.clone(),
      startTime: Date.now(),
      duration: 2500
    };
  }, []);

  const startDoorWalkthrough = useCallback(() => {
    if (!cameraRef.current || !controlsRef.current) {
      return;
    }

    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }

    const controls = controlsRef.current;
    const camera = cameraRef.current;
    controls.enabled = false;
    camera.position.copy(DOOR_CAM_POSITION);
    controls.target.copy(DOOR_CAM_TARGET);
    controls.update();

    flythroughRef.current = {
      active: true,
      phase: "walkto",
      startPos: camera.position.clone(),
      startTarget: controls.target.clone(),
      endPos: getWalkEndCameraPosition(),
      endTarget: MEDICATION_POSITION.clone(),
      startTime: Date.now(),
      duration: 5200
    };
  }, []);

  const updateFlythrough = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const flythrough = flythroughRef.current;
    if (!camera || !controls || !flythrough || !flythrough.active) {
      return;
    }

    const elapsed = Date.now() - flythrough.startTime;
    const rawProgress = Math.min(elapsed / flythrough.duration, 1);
    const eased =
      rawProgress < 0.5
        ? 4 * rawProgress ** 3
        : 1 - ((-2 * rawProgress + 2) ** 3) / 2;

    camera.position.lerpVectors(flythrough.startPos, flythrough.endPos, eased);
    controls.target.lerpVectors(flythrough.startTarget, flythrough.endTarget, eased);

    if (rawProgress < 1) {
      return;
    }

    if (flythrough.phase === "flyto") {
      flythrough.active = false;
      holdTimerRef.current = setTimeout(() => {
        if (!cameraRef.current || !controlsRef.current) {
          return;
        }
        flythroughRef.current = {
          active: true,
          phase: "return",
          startPos: cameraRef.current.position.clone(),
          startTarget: controlsRef.current.target.clone(),
          endPos: OVERVIEW_CAM_POSITION.clone(),
          endTarget: OVERVIEW_CAM_TARGET.clone(),
          startTime: Date.now(),
          duration: 1800
        };
      }, 3000);
      return;
    }

    if (flythrough.phase === "walkto") {
      flythroughRef.current = null;
      controls.enabled = true;
      return;
    }

    flythroughRef.current = null;
    controls.enabled = true;
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    const width = mount.clientWidth || 1;
    const height = mount.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0A0A0A");
    scene.fog = new THREE.Fog("#0A0A0A", 15, 30);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 100);
    camera.position.copy(OVERVIEW_CAM_POSITION);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    rendererRef.current = renderer;
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight("#ffffff", 0.6);
    scene.add(ambient);

    const directional = new THREE.DirectionalLight("#ffffff", 1.2);
    directional.position.set(5, 10, 5);
    directional.castShadow = true;
    scene.add(directional);

    const pillGlow = new THREE.PointLight("#5022c5", 0.4, 8);
    pillGlow.position.copy(MEDICATION_POSITION);
    scene.add(pillGlow);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.3;
    controls.maxDistance = 15;
    controls.maxPolarAngle = Math.PI * 0.85;
    controls.target.copy(OVERVIEW_CAM_TARGET);
    controls.update();
    controlsRef.current = controls;

    const addPillPinMarker = () => {
      const group = new THREE.Group();

      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.12, 16, 16),
        new THREE.MeshBasicMaterial({ color: "#5022c5" })
      );

      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.01, 0.01, 0.4, 12),
        new THREE.MeshBasicMaterial({
          color: "#5022c5",
          transparent: true,
          opacity: 0.5
        })
      );
      stem.position.set(0, -0.2, 0);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.15, 0.18, 32),
        new THREE.MeshBasicMaterial({
          color: "#5022c5",
          transparent: true,
          opacity: 0.3,
          side: THREE.DoubleSide
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(0, -0.4, 0);

      group.add(sphere);
      group.add(stem);
      group.add(ring);
      group.position.copy(MEDICATION_POSITION);
      scene.add(group);
      pillPinRef.current = group;
    };

    const fitCameraToModel = (boundingBox: THREE.Box3) => {
      const center = boundingBox.getCenter(new THREE.Vector3());
      const sphere = boundingBox.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, 0.001);

      camera.position.set(center.x, center.y + radius * 0.8, center.z + radius * 2);
      controls.target.copy(center);
      controls.update();
    };

    const loader = new GLTFLoader();
    loader.load(
      "/room_scan.glb",
      (gltf) => {
        const model = gltf.scene;
        const initialBox = new THREE.Box3().setFromObject(model);
        const initialCenter = initialBox.getCenter(new THREE.Vector3());
        const initialSize = initialBox.getSize(new THREE.Vector3());
        const maxDim = Math.max(initialSize.x, initialSize.y, initialSize.z, 0.001);
        const scale = 10 / maxDim;

        model.scale.setScalar(scale);
        model.position.sub(initialCenter.multiplyScalar(scale));

        model.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });

        scene.add(model);
        addPillPinMarker();

        const fittedBox = new THREE.Box3().setFromObject(model);
        fitCameraToModel(fittedBox);
        setLoading(false);
      },
      undefined,
      (error) => {
        console.error("GLB load error:", error);
        setLoadError(true);
        setLoading(false);
      }
    );

    const animate = () => {
      animFrameRef.current = window.requestAnimationFrame(animate);

      const t = Date.now() * 0.003;
      if (pillPinRef.current?.children[0]) {
        const scale = 1 + Math.sin(t) * 0.2;
        pillPinRef.current.children[0].scale.setScalar(scale);
      }

      updateFlythrough();
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = mount.clientWidth || 1;
      const nextHeight = mount.clientHeight || 1;
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(nextWidth, nextHeight);
    });
    resizeObserver.observe(mount);

    return () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }

      if (animFrameRef.current !== null) {
        window.cancelAnimationFrame(animFrameRef.current);
        animFrameRef.current = null;
      }

      resizeObserver.disconnect();

      controls.dispose();
      scene.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          if (mesh.material) {
            disposeMaterial(mesh.material);
          }
        }
      });

      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }

      pillPinRef.current = null;
      flythroughRef.current = null;
      controlsRef.current = null;
      cameraRef.current = null;
      sceneRef.current = null;
      rendererRef.current = null;
    };
  }, [updateFlythrough]);

  useEffect(() => {
    if (!flytoPill) {
      return;
    }
    startFlythrough(getPillCameraPosition(), MEDICATION_POSITION.clone());
  }, [flytoPill, startFlythrough]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" && event.key !== " ") {
        return;
      }

      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
        return;
      }

      event.preventDefault();
      startDoorWalkthrough();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [startDoorWalkthrough]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "480px",
        background: "#0A0A0A",
        borderRadius: "8px",
        overflow: "hidden",
        border: "1px solid #1A1A1A"
      }}
    >
      <div ref={mountRef} style={{ width: "100%", height: "100%" }} />

      {loading && !loadError ? (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "#444444",
            fontSize: "13px",
            textAlign: "center"
          }}
        >
          <div style={{ marginBottom: "8px" }}>Loading room scan...</div>
          <div style={{ width: "120px", height: "2px", background: "#1A1A1A", margin: "0 auto" }}>
            <div
              style={{
                height: "100%",
                background: "#333333",
                animation: "roomViewerPulse 1.5s ease-in-out infinite"
              }}
            />
          </div>
        </div>
      ) : null}

      {loadError ? (
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            color: "#EF4444",
            fontSize: "13px"
          }}
        >
          Failed to load room scan. Check that room_scan.glb is in /public/
        </div>
      ) : null}

      {pillDetected ? (
        <div
          style={{
            position: "absolute",
            top: "16px",
            left: "16px",
            background: "rgba(34, 197, 94, 0.12)",
            border: "1px solid #22C55E",
            borderRadius: "6px",
            padding: "8px 14px",
            color: "#22C55E",
            fontSize: "12px",
            fontWeight: "500",
            letterSpacing: "0.3px"
          }}
        >
          Medication located
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          bottom: "14px",
          right: "14px",
          color: "#2A2A2A",
          fontSize: "11px",
          letterSpacing: "0.3px"
        }}
      >
        Drag to rotate · Scroll to zoom · Press Space to walk to medication
      </div>

      <div
        style={{
          position: "absolute",
          bottom: "14px",
          left: "14px",
          display: "flex",
          gap: "12px",
          alignItems: "center"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
          <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#22C55E" }} />
          <span style={{ color: "#444444", fontSize: "11px" }}>Medication</span>
        </div>
      </div>

      <style jsx>{`
        @keyframes roomViewerPulse {
          0% {
            opacity: 0.35;
          }
          50% {
            opacity: 1;
          }
          100% {
            opacity: 0.35;
          }
        }
      `}</style>
    </div>
  );
}
