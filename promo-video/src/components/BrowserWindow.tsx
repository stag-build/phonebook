import React from "react";

export type BrowserWindowProps = {
  url: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
};

export const BrowserWindow: React.FC<BrowserWindowProps> = ({
  url,
  children,
  style,
}) => {
  return (
    <div
      style={{
        width: 1500,
        height: 860,
        borderRadius: 16,
        background: "#161618",
        border: "1px solid #2A2A2E",
        boxShadow: "0 40px 100px rgba(0,0,0,0.55)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "16px 22px",
          borderBottom: "1px solid #2A2A2E",
          background: "#1C1C1F",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 10 }}>
          <span style={dotStyle("#FF5F57")} />
          <span style={dotStyle("#FEBC2E")} />
          <span style={dotStyle("#28C840")} />
        </div>
        <div
          style={{
            flex: 1,
            background: "#0E0E10",
            borderRadius: 8,
            padding: "8px 18px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 18,
            color: "#A1A1AA",
          }}
        >
          {url}
        </div>
      </div>
      <div style={{ flex: 1, background: "#FFFFFF", overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
};

const dotStyle = (color: string): React.CSSProperties => ({
  width: 14,
  height: 14,
  borderRadius: "50%",
  background: color,
  display: "inline-block",
});
