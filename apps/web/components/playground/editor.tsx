"use client";

import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

const inkTheme = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)" },
  { tag: tags.tagName, color: "var(--accent)" },
  { tag: tags.atom, color: "var(--accent)" },
  { tag: tags.bracket, color: "var(--ink-2)" },
  { tag: tags.comment, color: "var(--ink-3)", fontStyle: "italic" },
  { tag: tags.string, color: "var(--ink)" },
  { tag: tags.number, color: "var(--ink)" },
  { tag: tags.typeName, color: "var(--ok)" },
  { tag: tags.labelName, color: "var(--ok)" },
]);

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}

export default function Editor({ value, onChange, ariaLabel }: EditorProps) {
  const extensions = useMemo(
    () => [
      StreamLanguage.define(stex),
      syntaxHighlighting(inkTheme),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
    ],
    [ariaLabel],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      height="100%"
      className="h-full"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        autocompletion: false,
        closeBrackets: false,
        bracketMatching: true,
        highlightSelectionMatches: false,
        searchKeymap: false,
      }}
    />
  );
}
