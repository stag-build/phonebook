import React from "react";
import { AbsoluteFill } from "remotion";

export const MusicCredit: React.FC = () => {
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          bottom: 20,
          right: 28,
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 16,
          fontWeight: 500,
          color: "rgba(255,255,255,0.95)",
          textShadow: "0 1px 3px rgba(0,0,0,0.6)",
          letterSpacing: 0.2,
        }}
      >
        Music: Kontraa Music — Pixabay
      </div>
    </AbsoluteFill>
  );
};
