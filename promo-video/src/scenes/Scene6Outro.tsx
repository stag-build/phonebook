import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const Scene6Outro: React.FC = () => {
  const frame = useCurrentFrame();

  const taglineOpacity = interpolate(frame, [6, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const taglineY = interpolate(frame, [6, 18], [20, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const logoOpacity = interpolate(frame, [28, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const badgeOpacity = interpolate(frame, [48, 60], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const fadeOutOpacity = interpolate(frame, [85, 110], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background:
          "radial-gradient(circle at 50% 40%, #1F2E28 0%, #09090B 70%)",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 48,
        }}
      >
        <div
          style={{
            opacity: taglineOpacity,
            transform: `translateY(${taglineY}px)`,
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontWeight: 600,
            fontSize: 52,
            color: "#F7F7F8",
            textAlign: "center",
          }}
        >
          Your previews, already a gallery.
        </div>

        <Img
          src={staticFile("logo/phonebook-logo-lockup.svg")}
          style={{ width: 480, opacity: logoOpacity }}
        />

        <div
          style={{
            opacity: badgeOpacity,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 26,
            color: "#D9EFE4",
            background: "#1F2E28",
            border: "1px solid #4C8C6B",
            borderRadius: 999,
            padding: "14px 32px",
          }}
        >
          npx @stag-build/phonebook
        </div>
      </div>

      <AbsoluteFill style={{ background: "#000000", opacity: fadeOutOpacity }} />
    </AbsoluteFill>
  );
};
