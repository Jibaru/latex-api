import { siteUrl } from "./shared";

export const heroCurl = `curl ${siteUrl}/v1/compile \\
  -H "Authorization: Bearer $LATEX_API_TOKEN" \\
  -H "Content-Type: text/x-tex" \\
  --data-binary @main.tex \\
  -o main.pdf`;

export const sampleCurl = `curl ${siteUrl}/v1/compile \\
  -H "Authorization: Bearer $LATEX_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/pdf" \\
  -d '{
    "engine": "pdflatex",
    "files": [
      { "path": "main.tex", "content": "\\\\documentclass{article}\\\\begin{document}Hello\\\\end{document}" }
    ]
  }' \\
  -o main.pdf`;

export const sampleJavaScript = `import { LatexApi } from "@jibaru/latex-api-sdk";
import { readFile, writeFile } from "node:fs/promises";

const api = new LatexApi({
  apiKey: process.env.LATEX_API_TOKEN,
  baseUrl: "${siteUrl}",
});

// Synchronous: a PDF comes back as a Uint8Array.
const pdf = await api.compile({
  files: [{ path: "main.tex", content: await readFile("main.tex", "utf8") }],
});
await writeFile("main.pdf", pdf);

// Asynchronous: create a job, then wait for it.
const job = await api.jobs.create({ files: [{ path: "main.tex", content: "..." }] });
const done = await api.jobs.wait(job.id);
console.log(done.status, done.result?.pdfUrl);`;

export const sampleCli = `# Install nothing; run it with npx (or: npm i -g @jibaru/latex-api-cli)
npx @jibaru/latex-api-cli login

# Compile a folder (zipped and uploaded for you) and write paper.pdf
npx @jibaru/latex-api-cli compile ./paper -o paper.pdf

# Recompile on every save, streaming the log over SSE
npx @jibaru/latex-api-cli compile ./paper --watch

# Start from a template
npx @jibaru/latex-api-cli templates init ieee-conference ./paper`;

export const samplePython = `import os
import requests

r = requests.post(
    "${siteUrl}/v1/compile",
    headers={
        "Authorization": f"Bearer {os.environ['LATEX_API_TOKEN']}",
        "Accept": "application/pdf",
    },
    json={
        "engine": "xelatex",
        "files": [{"path": "main.tex", "content": open("main.tex").read()}],
    },
    timeout=90,
)

if r.status_code == 200:
    open("main.pdf", "wb").write(r.content)
elif r.status_code == 422:
    for d in r.json()["diagnostics"]:
        print(f"{d['severity']} {d.get('file')}:{d.get('line')} {d['message']}")
else:
    r.raise_for_status()`;

export const playgroundSource = `\\documentclass[11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath}
\\usepackage{booktabs}

\\title{A Note on Typesetting over HTTP}
\\author{Edited in the playground}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
This document was compiled by a sandboxed \\TeX{} Live 2026 container.
Change anything, press \\emph{Compile}, and the PDF on the right is replaced.

\\section{Mathematics}
The Euler--Lagrange equation for a functional
$J[y] = \\int_a^b L(x, y, y')\\,dx$ reads
\\begin{equation}
  \\frac{\\partial L}{\\partial y} - \\frac{d}{dx}\\frac{\\partial L}{\\partial y'} = 0.
\\end{equation}

\\section{A table}
\\begin{center}
\\begin{tabular}{lrr}
  \\toprule
  Engine & Unicode & Fonts \\\\
  \\midrule
  pdfLaTeX & partial & Type 1 \\\\
  XeLaTeX  & yes     & OpenType \\\\
  LuaLaTeX & yes     & OpenType \\\\
  \\bottomrule
\\end{tabular}
\\end{center}

\\end{document}
`;
