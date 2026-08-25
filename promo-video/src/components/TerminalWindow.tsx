import React from "react";

export type TerminalWindowProps = {
  title: string;
  children: React.ReactNode;
};

export const TerminalWindow: React.FC<TerminalWindowProps> = ({
  title,
  children,
}) => {
  return (
    <div
      style={{
        width: 1280,
        minHeight: 620,
        borderRadius: 18,
        background: "#0E1512",
        border: "1px solid #1F2E28",
        boxShadow: "0 40px 100px rgba(0,0,0,0.55)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "18px 26px",
          borderBottom: "1px solid #1F2E28",
          background: "#111A16",
        }}
      >
        <div style={{ display: "flex", gap: 10 }}>
          <span style={dotStyle("#FF5F57")} />
          <span style={dotStyle("#FEBC2E")} />
          <span style={dotStyle("#28C840")} />
        </div>
        <span
          style={{
            marginLeft: 12,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontWeight: 500,
            fontSize: 19,
            color: "#A1A1AA",
          }}
        >
          {title}
        </span>
      </div>
      <div
        style={{
          padding: "40px 44px",
          display: "flex",
          flexDirection: "column",
          gap: 22,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 26,
        }}
      >
        {children}
      </div>
    </div>
  );
};

const dotStyle = (color: string): React.CSSProperties => ({
  width: 16,
  height: 16,
  borderRadius: "50%",
  background: color,
  display: "inline-block",
});
