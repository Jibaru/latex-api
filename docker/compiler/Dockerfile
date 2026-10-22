# syntax=docker/dockerfile:1.7
# latex-compiler: TeX Live 2026 trimmed to what papers, CVs, brochures and posters need.
# Runs one compile per container; see docker/compiler/compile.sh.
FROM debian:trixie-slim AS base

ARG TEXLIVE_MIRROR=https://mirror.ctan.org/systems/texlive/tlnet
ENV DEBIAN_FRONTEND=noninteractive \
    TEXDIR=/opt/texlive \
    PATH=/opt/texlive/bin/x86_64-linux:/opt/texlive/bin/aarch64-linux:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl perl xz-utils fontconfig libfontconfig1 tini \
      libc6 libgcc-s1 libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

# ---- TeX Live base (scheme-small: pdftex, xetex, luatex, biblatex, pgf, fontspec)
COPY texlive.profile /tmp/texlive.profile
RUN set -eux; \
    mkdir -p /tmp/install-tl && cd /tmp/install-tl; \
    curl -fsSL "${TEXLIVE_MIRROR}/install-tl-unx.tar.gz" | tar xz --strip-components=1; \
    ./install-tl --profile=/tmp/texlive.profile --repository "${TEXLIVE_MIRROR}" --no-interaction; \
    rm -rf /tmp/install-tl /tmp/texlive.profile

# ---- Extra collections and packages for the target document types.
# NEVER add collection-publishers or collection-fontsextra: they pull 2+ GB of fonts.
RUN set -eux; \
    tlmgr option repository "${TEXLIVE_MIRROR}"; \
    tlmgr install \
      collection-pictures collection-latexextra collection-bibtexextra collection-luatex \
      collection-fontsrecommended collection-langspanish collection-mathscience collection-binextra \
      latexmk biber ieeetran fontawesome5 fontawesome6 academicons simpleicons \
      roboto sourcesans lato raleway fira firamath inter montserrat \
      lm-math xits libertinus-fonts gnu-freefont \
      biblatex-ieee biblatex-apa; \
    tlmgr option autobackup 0; \
    rm -rf /opt/texlive/tlpkg/backups /opt/texlive/texmf-dist/doc /opt/texlive/texmf-dist/source

# ---- Fonts: let fontspec find TeX Live OpenType fonts by family name.
RUN set -eux; \
    mkdir -p /etc/fonts/conf.d; \
    ln -sf /opt/texlive/texmf-var/fonts/conf/texlive-fontconfig.conf /etc/fonts/conf.d/09-texlive.conf; \
    fc-cache -fs; \
    luaotfload-tool --update --force || true

# ---- Hardening defaults baked into texmf.cnf (the runtime also disables shell escape).
RUN set -eux; \
    printf '\n%% latex-api hardening\nshell_escape = f\nopenout_any = p\nopenin_any = a\n' >> /opt/texlive/texmf.cnf; \
    useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin tex

# ---- Warm up formats and font caches with one document per engine.
COPY warm /tmp/warm
RUN set -eux; cd /tmp/warm; \
    latexmk -pdf -interaction=nonstopmode -halt-on-error warm-pdflatex.tex; \
    latexmk -xelatex -interaction=nonstopmode -halt-on-error warm-xelatex.tex; \
    TEXMFVAR=/opt/texlive/texmf-var latexmk -lualatex -interaction=nonstopmode -halt-on-error warm-lualatex.tex; \
    cd / && rm -rf /tmp/warm

COPY --chmod=0755 compile.sh /usr/local/bin/compile
COPY VERSION /etc/latex-compiler-version

ENV HOME=/tmp/home \
    TEXMFVAR=/tmp/home/texmf-var \
    TEXMFCONFIG=/tmp/home/texmf-config \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/compile"]
CMD ["--help"]
