import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export const Scene2Sting: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const textScale = spring({
    frame: frame - 3,
    fps,
    config: { damping: 12, stiffness: 220, mass: 0.5 },
  });
  const textOpacity = interpolate(frame, [3, 10, 20, 26], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const logoOpacity = interpolate(frame, [24, 55], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const logoScale = interpolate(frame, [24, 55], [0.85, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "#09090B",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          position: "absolute",
          opacity: textOpacity,
          transform: `scale(${textScale})`,
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontWeight: 800,
          fontSize: 96,
          letterSpacing: -1,
          color: "#F7F7F8",
        }}
      >
        YES, YOU CAN.
      </div>

      <div
        style={{
          position: "absolute",
          opacity: logoOpacity,
          transform: `scale(${logoScale})`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 28,
        }}
      >
        <Img
          src={staticFile("logo/phonebook-logo-mark.svg")}
          style={{ width: 140, height: 140 }}
        />
        <div
          style={{
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontWeight: 800,
            fontSize: 64,
            letterSpacing: 6,
            color: "#F7F7F8",
          }}
        >
          PHONEBOOK
        </div>
      </div>
    </AbsoluteFill>
  );
};
