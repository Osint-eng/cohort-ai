import { describe, expect, it } from "vitest"
import { compilePreviewSrcDoc } from "./task-sandbox"

describe("compilePreviewSrcDoc (react)", () => {
  it("loads pinned React 18.3.1 and ReactDOM 18.3.1 UMD builds from cdnjs and mounts with ReactDOM.createRoot", () => {
    const result = compilePreviewSrcDoc(
      {
        "src/App.jsx": `import React, { useReducer, useId } from "react";
export default function App() {
  const id = useId();
  const [count, inc] = useReducer((c) => c + 1, 0);
  return <button id={id} onClick={inc}>{count}</button>;
}`,
        "src/styles.css": "button { color: orange; }",
        "index.html": '<!DOCTYPE html><html><head></head><body><div id="root"></div></body></html>',
      },
      "react"
    )

    expect(result.compileError).toBeNull()
    expect(result.html).toContain(
      "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"
    )
    expect(result.html).toContain(
      "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"
    )
    expect(result.html).toContain("ReactDOM.createRoot(mountNode).render(React.createElement(AppComponent, null))")
    expect(result.html).toContain("Preview Runtime Error")
    expect(result.html).not.toContain("MICRO_REACT_IFRAME_RUNTIME")
    expect(result.html).not.toContain("hookStates")
  })

  it("returns compileError on invalid JSX", () => {
    const result = compilePreviewSrcDoc(
      {
        "src/App.jsx": "export default function App() { return <div>; }",
      },
      "react"
    )

    expect(result.compileError).toBeTruthy()
    expect(result.html).toContain("JSX Compile Error")
  })
})
