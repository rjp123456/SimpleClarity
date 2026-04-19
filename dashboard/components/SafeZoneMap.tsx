"use client";

import L from "leaflet";
import { useEffect, useMemo, useState } from "react";
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, Tooltip, useMap } from "react-leaflet";
import type { LatLngExpression } from "leaflet";

type SafeZoneMapProps = {
  center: { latitude: number; longitude: number };
  radius: number;
  popToken?: number;
  patientLocation?: { latitude: number; longitude: number } | null;
  flyTo?: { lat: number; lng: number } | null;
  onCenterChange: (latitude: number, longitude: number) => void;
  onCenterDragStart?: () => void;
  onCenterDragEnd?: () => void;
  onFlyToConsumed?: () => void;
};

function FlyToLocation({
  target,
  onConsumed
}: {
  target: { lat: number; lng: number };
  onConsumed?: () => void;
}) {
  const map = useMap();
  useEffect(() => {
    map.flyTo([target.lat, target.lng], 15, { duration: 1.2 });
    onConsumed?.();
  }, [target, map, onConsumed]);
  return null;
}

export default function SafeZoneMap({
  center,
  radius,
  popToken = 0,
  patientLocation,
  flyTo,
  onCenterChange,
  onCenterDragStart,
  onCenterDragEnd,
  onFlyToConsumed
}: SafeZoneMapProps) {
  const [isPopActive, setIsPopActive] = useState(false);
  const position: LatLngExpression = [center.latitude, center.longitude];
  const patientPosition: LatLngExpression | null = patientLocation
    ? [patientLocation.latitude, patientLocation.longitude]
    : null;
  const dragIcon = useMemo(
    () =>
      L.divIcon({
        className: "zone-drag-icon",
        html: `<div class="zone-drag-handle${isPopActive ? " pop" : ""}"></div>`,
        iconAnchor: [12, 12],
        iconSize: [24, 24],
      }),
    [isPopActive]
  );

  useEffect(() => {
    if (popToken <= 0) {
      return;
    }
    setIsPopActive(true);
    const timer = setTimeout(() => setIsPopActive(false), 240);
    return () => clearTimeout(timer);
  }, [popToken]);

  return (
    <div className="map-shell">
      <MapContainer
        center={position}
        zoom={14}
        scrollWheelZoom
        style={{ height: 400, width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <Circle
          center={position}
          radius={radius}
          pathOptions={{ color: "#22C55E", fillColor: "#22C55E", fillOpacity: 0.1 }}
        />
        <Marker
          draggable
          eventHandlers={{
            dragstart() {
              onCenterDragStart?.();
            },
            drag(e) {
              const latlng = (e.target as L.Marker).getLatLng();
              onCenterChange(latlng.lat, latlng.lng);
            },
            dragend(e) {
              const latlng = (e.target as L.Marker).getLatLng();
              onCenterChange(latlng.lat, latlng.lng);
              onCenterDragEnd?.();
            }
          }}
          icon={dragIcon}
          position={position}
        >
          <Tooltip direction="top" offset={[0, -18]} opacity={0.9}>
            Drag to reposition
          </Tooltip>
        </Marker>
        {patientPosition ? (
          <CircleMarker
            center={patientPosition}
            pathOptions={{ color: "#EF4444", fillColor: "#EF4444", fillOpacity: 0.9 }}
            radius={8}
          >
            <Tooltip direction="top" offset={[0, -10]} opacity={0.95} permanent>
              Patient Phone
            </Tooltip>
          </CircleMarker>
        ) : null}
        {flyTo ? <FlyToLocation onConsumed={onFlyToConsumed} target={flyTo} /> : null}
      </MapContainer>
    </div>
  );
}
