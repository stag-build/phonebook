import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { TerminalWindow } from "../components/TerminalWindow";

const TypedLine: React.FC<{
  frame: number;
  start: number;
  end: number;
  text: string;
  color: string;
  prefix?: string;
}> = ({ frame, start, end, text, color, prefix }) => {
  const progress = interpolate(frame, [start, end], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (progress <= 0) return null;
  const chars = Math.round(text.length * progress);
  return (
    <div style={{ color, whiteSpace: "pre" }}>
      {prefix ? <span style={{ color: "#4C8C6B" }}>{prefix} </span> : null}
      {text.slice(0, chars)}
    </div>
  );
};

const ToolPill: React.FC<{
  frame: number;
  appearAt: number;
  doneAt: number;
  progressEnd?: number;
  label: string;
}> = ({ frame, appearAt, doneAt, progressEnd, label }) => {
  const opacity = interpolate(frame, [appearAt, appearAt + 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;
  const done = frame >= doneAt;
  const barEnd = progressEnd ?? doneAt;
  const barProgress = interpolate(frame, [appearAt, barEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ opacity, display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          background: "#161F1B",
          border: "1px solid #2A3B33",
          borderRadius: 12,
          padding: "12px 20px",
          width: "fit-content",
        }}
      >
        <span
          style={{
            fontSize: 22,
            color: done ? "#4C8C6B" : "#D9EFE4",
          }}
        >
          {done ? "✓" : "◐"}
        </span>
        <span style={{ color: "#D4D4D8", fontSize: 24 }}>{label}</span>
      </div>
      {!done ? (
        <div
          style={{
            width: 260,
            height: 4,
            borderRadius: 2,
            background: "#2A3B33",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${barProgress * 100}%`,
              height: "100%",
              background: "#4C8C6B",
            }}
          />
        </div>
      ) : null}
    </div>
  );
};

export const Scene3And4Terminal: React.FC = () => {
  const frame = useCurrentFrame();

  const tabsOpacity = interpolate(frame, [0, 30], [0, 0.18], {
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
          top: 140,
          left: 260,
          opacity: tabsOpacity,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 20,
          color: "#D4D4D8",
          filter: "blur(1px)",
        }}
      >
        HomeScreen.kt
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 160,
          right: 240,
          opacity: tabsOpacity,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 20,
          color: "#D4D4D8",
          filter: "blur(1px)",
        }}
      >
        ProfileView.swift
      </div>

      <TerminalWindow title="~/mobile-app — claude">
        <TypedLine
          frame={frame}
          start={8}
          end={20}
          prefix="❯"
          text="my designer wants a catalog of our components"
          color="#F7F7F8"
        />
        <TypedLine
          frame={frame}
          start={30}
          end={42}
          prefix="●"
          text="Why don't you use Phonebook?"
          color="#D9EFE4"
        />
        <TypedLine
          frame={frame}
          start={52}
          end={64}
          prefix="❯"
          text="...what's Phonebook?"
          color="#F7F7F8"
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 12 }}>
          <ToolPill frame={frame} appearAt={75} doneAt={88} label="phonebook_doctor" />
          <ToolPill
            frame={frame}
            appearAt={100}
            doneAt={130}
            progressEnd={130}
            label="phonebook_generate"
          />
          <ToolPill frame={frame} appearAt={140} doneAt={160} label="phonebook_build" />
        </div>

        <TypedLine
          frame={frame}
          start={175}
          end={187}
          prefix="●"
          text="Done — here's your gallery."
          color="#D9EFE4"
        />
      </TerminalWindow>
    </AbsoluteFill>
  );
};
