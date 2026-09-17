"use strict";

const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const rec = require("../local_storage/session_objects_logic/record");

const REDIRECT_RE =
  /(?:>>?|\btee\b(?:\s+-{1,2}[\w-]+)*|(?:^|\s)-o(?=\s)|--output(?:=|\s+)|\bof=)\s*(?:'([^']+)'|"([^"]+)"|([^\s"';|&<>]+))/g;
const WS_PAD_RE = /[ \t]{2,}/g;
const SHELL_TOKEN_RE = /'([^']*)'|"([^"]*)"|(\S+)/g;
const COPY_BINS = new Set(["cp", "mv", "install", "rsync", "ditto", "ln"]);
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETERS = new Set(["python", "python3", "node", "perl", "ruby"]);
const INTERP_INLINE_FLAGS = new Set(["-c", "-e"]);
const INTERP_API_COPY_RE =
  /(?:shutil\.copy(?:file)?|copyFileSync|FileUtils\.(?:cp|copy)|(?:use\s+File::Copy\s*;\s*)?copy)\s*\([^)]*?,\s*['"]([^'"]+)['"]/gi;
const INTERP_API_WRITE_RES = [
  /\bopen\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*[waxWAX][^'"]*['"]/g,
  /\bPath\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*write_(?:text|bytes)\b/g,
  /(?:writeFileSync|appendFileSync|createWriteStream|writeFile|file_put_contents)\s*\(\s*['"]([^'"]+)['"]/g,
  /(?:File|IO)\.write\s*\(\s*['"]([^'"]+)['"]/g,
  /(?:File\.open|fopen|io\.open)\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*[waxWAX][^'"]*['"]/g,
  /(?:os\.WriteFile|os\.Create|ioutil\.WriteFile)\s*\(\s*"([^"]+)"/g,
  /\bopen\b[^,;()]*,\s*['"]>>?['"]\s*,\s*['"]([^'"]+)['"]/g,
  /\bopen\s+(?:'([^']+)'|"([^"]+)"|([^\s;'"]+))\s+w\b/g,
  /POSIX file\s+['"]([^'"]+)['"]/g,
  /\.output\s+(?:'([^']+)'|"([^"]+)"|([^\s;]+))/g,
  /\b(?:ed|ex)\s+(?:-\w+\s+)*(?:'([^']+)'|"([^"]+)"|([^\s;'"]+))/g,
  /\bsponge\s+(?:-\w+\s+)*(?:'([^']+)'|"([^"]+)"|([^\s;|&<>'"]+))/g,
];
const SCRIPT_INLINE = new Set(["eval", "exec"]);
const COPY_FLAGS_WITH_ARG = new Set([
  "-t", "--target-directory", "-S", "--suffix", "-m", "--mode",
  "-o", "--owner", "-g", "--group", "-Z", "--context", "--backup",
]);
const DEV_SINKS = new Set(["/dev/null", "/dev/stdin", "/dev/stdout", "/dev/stderr"]);
const XARGS_FLAGS_WITH_ARG = new Set([
  "-I", "-i", "-E", "-e", "-J", "-j", "-L", "-l", "-n", "-P", "-s",
  "--replace", "--interactive", "--eof", "--max-args", "--max-procs", "--max-chars",
]);
const INPLACE_BINS = new Set(["sed", "gsed", "perl", "ruby"]);
const INPLACE_FLAG_RE = /^-{1,2}(?:i|in-place)(?:=.*|\..*)?$|^-\w*i\w*$/;
const INPLACE_ARG_FLAGS = new Set(["-e", "-f", "--expression", "--file", "-l", "-F"]);
const PATCH_TGT_RE = /^\+\+\+\s+(?:b\/)?(\S+)/gm;
const TAR_FLAG_CLUSTER = /^-?[AcdrtuxzjJZwvfhOpPkKmSW]+$/;
const STMT_SPLIT = /(?:&&|\|\||[;\n])/;

function isDevSink(p) {
  return DEV_SINKS.has(p) || String(p).startsWith("/dev/fd/");
}

function allMatches(re, s) {
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m;
  while ((m = rx.exec(s))) out.push(m);
  return out;
}

function firstGroup(m) {
  for (let i = 1; i < m.length; i++) if (m[i]) return m[i];
  return null;
}

function shellRedirectTargets(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const m of allMatches(REDIRECT_RE, cmd)) {
    const p = firstGroup(m);
    if (!p || seen.has(p) || isDevSink(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function shellTokens(stmt) {
  const out = [];
  for (const m of allMatches(SHELL_TOKEN_RE, stmt)) {
    out.push(m[1] != null && m[1] !== undefined && m[0].startsWith("'") ? m[1]
      : m[2] != null && m[0].startsWith('"') ? m[2]
      : m[3]);
  }
  return out.filter((t) => t !== undefined);
}

function skipXargsFlags(tokens, start) {
  let j = start;
  while (j < tokens.length) {
    const t = tokens[j];
    if (XARGS_FLAGS_WITH_ARG.has(t)) {
      j += j + 1 < tokens.length ? 2 : 1;
      continue;
    }
    if (t.startsWith("-") && t !== "-" && t !== "--") {
      j += 1;
      continue;
    }
    break;
  }
  return j;
}

function nestedInnerSlices(tokens) {
  const slices = [];
  tokens.forEach((t, i) => {
    if (t.split("/").pop() !== "xargs") return;
    const j = skipXargsFlags(tokens, i + 1);
    if (j < tokens.length) slices.push(tokens.slice(j));
  });
  if (tokens.includes("-exec")) {
    const execI = tokens.indexOf("-exec");
    let j = execI + 1;
    while (j < tokens.length && tokens[j] !== "\\;" && tokens[j] !== ";") j += 1;
    if (j > execI + 1) slices.push(tokens.slice(execI + 1, j));
  }
  return slices;
}

function copyDestFromTokens(tokens, binI) {
  let targetDir = null;
  const positionals = [];
  let j = binI + 1;
  while (j < tokens.length) {
    const t = tokens[j];
    if (t === "--") {
      positionals.push(...tokens.slice(j + 1));
      break;
    }
    if (t.startsWith("-") && t !== "-" && t !== "--") {
      if (t.includes("=")) {
        const [key, val] = t.split("=", 2);
        if (key === "-t" || key === "--target-directory") targetDir = val;
        j += 1;
        continue;
      }
      if (COPY_FLAGS_WITH_ARG.has(t)) {
        if ((t === "-t" || t === "--target-directory") && j + 1 < tokens.length) {
          targetDir = tokens[j + 1];
          j += 2;
          continue;
        }
        j += j + 1 < tokens.length ? 2 : 1;
        continue;
      }
      j += 1;
      continue;
    }
    positionals.push(t);
    j += 1;
  }
  if (targetDir) return targetDir;
  if (positionals.length >= 2) return positionals[positionals.length - 1];
  return null;
}

function isPrefixWrapper(t) {
  return ["sudo", "command", "time", "nice", "nohup", "env"].includes(t)
    || (t.includes("=") && !t.startsWith("-") && !t.split("=", 1)[0].includes("/"));
}

function copyTargetsOnTokens(tokens, out, seen, onlyAt) {
  if (!tokens || !tokens.length) return;
  const indices = onlyAt != null ? [onlyAt] : tokens.map((_, i) => i);
  for (let i of indices) {
    if (onlyAt == null) {
      const t = tokens[i];
      if (isPrefixWrapper(t)) continue;
      if (!COPY_BINS.has(tokens[i].split("/").pop())) continue;
    }
    const binname = tokens[i].split("/").pop();
    if (!COPY_BINS.has(binname)) continue;
    const dest = copyDestFromTokens(tokens, i);
    if (!dest || isDevSink(dest) || seen.has(dest)) continue;
    seen.add(dest);
    out.push(dest);
  }
}

function collectInners(cmd, rx) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const m of allMatches(rx, cmd)) {
    const inner = (m[1] || "").trim();
    if (inner && !seen.has(inner)) {
      seen.add(inner);
      out.push(inner);
    }
  }
  return out;
}

function shellSubshellInners(cmd) {
  return collectInners(cmd, /(?<!\$)\(([^)]+)\)/g);
}
function shellBraceGroupInners(cmd) {
  return collectInners(cmd, /(?<!\$)\{([^}]+)\}/g);
}

function shellControlFlowInners(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const stmt of cmd.split(STMT_SPLIT)) {
    const s = stmt.trim();
    let inner = null;
    if (s.startsWith("then ")) inner = s.slice(5).trim();
    else if (s.startsWith("do ")) inner = s.slice(3).trim();
    if (inner && !seen.has(inner)) {
      seen.add(inner);
      out.push(inner);
    }
  }
  return out;
}

function shellSubstitutionInners(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const m of allMatches(/`([^`]+)`/g, cmd).concat(allMatches(/\$\(([^)]+)\)/g, cmd))) {
    const inner = m[1];
    if (inner && !seen.has(inner)) {
      seen.add(inner);
      out.push(inner);
    }
  }
  return out;
}

function skipWrappers(tokens) {
  let i = 0;
  while (i < tokens.length && isPrefixWrapper(tokens[i])) i += 1;
  return i;
}

function shellNestedSurfaces(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const stmt of cmd.split(STMT_SPLIT)) {
    for (const segment of stmt.split("|")) {
      const tokens = shellTokens(segment.trim()).filter(Boolean);
      for (const inner of nestedInnerSlices(tokens)) {
        const innerS = inner.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" ");
        if (innerS && !seen.has(innerS)) {
          seen.add(innerS);
          out.push(innerS);
        }
      }
    }
  }
  return out;
}

function interpreterApiCopyTargets(surface) {
  if (!surface) return [];
  const out = [];
  const seen = new Set();
  for (const m of allMatches(INTERP_API_COPY_RE, surface)) {
    const p = m[1];
    if (!p || seen.has(p) || isDevSink(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function interpreterApiWriteTargets(surface) {
  if (!surface) return [];
  const out = [];
  const seen = new Set();
  for (const rx of INTERP_API_WRITE_RES) {
    for (const m of allMatches(rx, surface)) {
      const p = firstGroup(m);
      if (!p || seen.has(p) || isDevSink(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function shellInterpreterInners(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const stmt of cmd.split(STMT_SPLIT)) {
    const tokens = shellTokens(stmt.trim()).filter(Boolean);
    const i = skipWrappers(tokens);
    if (i >= tokens.length) continue;
    if (!INTERPRETERS.has(tokens[i].split("/").pop())) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (INTERP_INLINE_FLAGS.has(t)) {
        if (j + 1 < tokens.length && tokens[j + 1] && !seen.has(tokens[j + 1])) {
          seen.add(tokens[j + 1]);
          out.push(tokens[j + 1]);
        }
        break;
      }
      if (t.startsWith("-") && t !== "-" && t !== "--") continue;
    }
  }
  return out;
}

function shellWrapperInners(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const stmt of cmd.split(STMT_SPLIT)) {
    const tokens = shellTokens(stmt.trim()).filter(Boolean);
    const i = skipWrappers(tokens);
    if (i >= tokens.length) continue;
    const binname = tokens[i].split("/").pop();
    if (SCRIPT_INLINE.has(binname)) {
      if (i + 1 < tokens.length) {
        const inner = binname === "exec"
          ? tokens.slice(i + 1).map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" ")
          : tokens[i + 1];
        if (inner && !seen.has(inner)) {
          seen.add(inner);
          out.push(inner);
        }
      }
      continue;
    }
    if (!SHELL_WRAPPERS.has(binname)) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (t === "-c" || (t.startsWith("-") && t.includes("c") && t !== "-" && t !== "--")) {
        if (j + 1 < tokens.length && !seen.has(tokens[j + 1])) {
          seen.add(tokens[j + 1]);
          out.push(tokens[j + 1]);
        }
        break;
      }
    }
  }
  return out;
}

function shellCopyTargets(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const stmt of cmd.split(STMT_SPLIT)) {
    for (const segment of stmt.split("|")) {
      const tokens = shellTokens(segment.trim()).filter(Boolean);
      if (!tokens.length) continue;
      const i = skipWrappers(tokens);
      if (i < tokens.length) copyTargetsOnTokens(tokens, out, seen, i);
      for (const inner of nestedInnerSlices(tokens)) copyTargetsOnTokens(inner, out, seen, 0);
    }
  }
  return out;
}

function inplaceEditTargets(cmd) {
  if (!cmd) return [];
  const out = [];
  const seen = new Set();
  for (const stmt of cmd.split(STMT_SPLIT)) {
    for (const segment of stmt.split("|")) {
      const tokens = shellTokens(segment.trim()).filter(Boolean);
      const i = skipWrappers(tokens);
      if (i >= tokens.length) continue;
      const binname = tokens[i].split("/").pop();
      if (!INPLACE_BINS.has(binname)) continue;
      const rest = tokens.slice(i + 1);
      if (!rest.some((t) => INPLACE_FLAG_RE.test(t))) continue;
      const hasExpr = rest.some((t) => INPLACE_ARG_FLAGS.has(t) || t.startsWith("--expression") || t.startsWith("--file"));
      const positionals = [];
      for (let j = 0; j < rest.length; ) {
        const t = rest[j];
        if (INPLACE_ARG_FLAGS.has(t)) {
          j += 2;
          continue;
        }
        if (t.startsWith("-") && t !== "-" && t !== "--") {
          j += 1;
          continue;
        }
        positionals.push(t);
        j += 1;
      }
      const files = hasExpr ? positionals : positionals.slice(1);
      for (const p of files) {
        if (p && !seen.has(p) && !isDevSink(p)) {
          seen.add(p);
          out.push(p);
        }
      }
    }
  }
  return out;
}

function patchTargets(cmd) {
  if (!cmd || (!cmd.includes("patch") && !cmd.includes("apply"))) return [];
  const out = [];
  const seen = new Set();
  for (const m of allMatches(PATCH_TGT_RE, cmd)) {
    const p = m[1];
    if (!p || seen.has(p) || isDevSink(p) || p === "/dev/null") continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function shellWriteTargets(cmd) {
  const out = [];
  const seen = new Set();
  const surfaces = cmd ? [cmd] : [];
  surfaces.push(...shellWrapperInners(cmd));
  surfaces.push(...shellNestedSurfaces(cmd));
  surfaces.push(...shellSubstitutionInners(cmd));
  surfaces.push(...shellSubshellInners(cmd));
  surfaces.push(...shellBraceGroupInners(cmd));
  surfaces.push(...shellControlFlowInners(cmd));
  surfaces.push(...shellInterpreterInners(cmd));
  for (const surface of surfaces) {
    for (const p of []
      .concat(shellRedirectTargets(surface))
      .concat(shellCopyTargets(surface))
      .concat(interpreterApiCopyTargets(surface))
      .concat(interpreterApiWriteTargets(surface))
      .concat(inplaceEditTargets(surface))
      .concat(patchTargets(surface))) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function tarIsExtract(rest) {
  return rest.some((t) => t === "--extract" || t === "--get"
    || (TAR_FLAG_CLUSTER.test(t) && t.replace(/^-/, "").includes("x")));
}

function tarArchiveAndDir(rest) {
  let archive = null;
  let extDir = null;
  const positionals = [];
  for (let j = 0; j < rest.length; ) {
    const t = rest[j];
    if (t.startsWith("--file=")) {
      archive = t.split("=").slice(1).join("=");
      j += 1;
    } else if (t.startsWith("--directory=")) {
      extDir = t.split("=").slice(1).join("=");
      j += 1;
    } else if (t === "-C" || t === "--directory") {
      if (j + 1 < rest.length) {
        extDir = rest[j + 1];
        j += 2;
        continue;
      }
      j += 1;
    } else if (t === "-f" || t === "--file") {
      if (j + 1 < rest.length) {
        archive = rest[j + 1];
        j += 2;
        continue;
      }
      j += 1;
    } else if (TAR_FLAG_CLUSTER.test(t) && t.replace(/^-/, "").includes("f") && !t.includes("=")) {
      if (j + 1 < rest.length) {
        archive = rest[j + 1];
        j += 2;
        continue;
      }
      j += 1;
    } else if (!t.startsWith("-")) {
      positionals.push(t);
      j += 1;
    } else {
      j += 1;
    }
  }
  if (!archive && positionals.length) archive = positionals[0];
  return [archive, extDir];
}

function archiveExtractTargets(cmd, cwd) {
  if (!cmd) return [];
  const base = cwd ? expandUser(cwd) : process.cwd();
  function abs(rel, extDir) {
    let root = extDir || base;
    if (!path.isAbsolute(root)) root = path.join(base, root);
    return path.resolve(path.join(expandUser(root), rel));
  }
  const out = [];
  const seen = new Set();
  for (const stmt of cmd.split(STMT_SPLIT)) {
    const tokens = shellTokens(stmt.trim()).filter(Boolean);
    const i = skipWrappers(tokens);
    if (i >= tokens.length) continue;
    const binname = tokens[i].split("/").pop();
    const rest = tokens.slice(i + 1);
    let members = null;
    let extDir = null;
    try {
      if (binname === "tar" && tarIsExtract(rest)) {
        let archive;
        [archive, extDir] = tarArchiveAndDir(rest);
        if (!archive) continue;
        const archAbs = path.isAbsolute(archive) ? archive : path.join(base, archive);
        const r = spawnSync("tar", ["-tf", archAbs], { encoding: "utf8", timeout: 8000 });
        if (r.status === 0) {
          members = (r.stdout || "").split(/\n/).filter((m) => m && !m.endsWith("/"));
        }
      } else if (binname === "unzip") {
        let archive = null;
        for (let j = 0; j < rest.length; ) {
          if (rest[j] === "-d" && j + 1 < rest.length) {
            extDir = rest[j + 1];
            j += 2;
            continue;
          }
          if (!rest[j].startsWith("-") && !archive) archive = rest[j];
          j += 1;
        }
        if (!archive) continue;
        const archAbs = path.isAbsolute(archive) ? archive : path.join(base, archive);
        const r = spawnSync("unzip", ["-Z1", archAbs], { encoding: "utf8", timeout: 8000 });
        if (r.status === 0) {
          members = (r.stdout || "").split(/\n/).filter((m) => m && !m.endsWith("/"));
        }
      }
    } catch {
      members = null;
    }
    if (members) {
      for (const m of members) {
        const ap = abs(m, extDir);
        if (!seen.has(ap) && !isDevSink(ap)) {
          seen.add(ap);
          out.push(ap);
        }
      }
    }
  }
  return out;
}

function expandUser(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function canonicalPath(p, cwd) {
  p = expandUser(p);
  if (!path.isAbsolute(p) && cwd) p = path.join(expandUser(cwd), p);
  return path.resolve(p);
}

function pathsTouched(record) {
  const out = [];
  const seen = new Set();
  const cwd = rec.eventCwd(record);
  function add(p) {
    if (!p) return;
    p = canonicalPath(p, cwd);
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  }
  if (record.file_path) add(record.file_path);
  const ti = rec.toolInput(record);
  if (ti.file_path) add(ti.file_path);
  if (ti.path) add(ti.path);
  for (const p of shellWriteTargets(rec.commandOf(record))) add(p);
  if (Array.isArray(record._extract_targets)) {
    for (const p of record._extract_targets) add(p);
  }
  return out;
}

module.exports = {
  pathsTouched,
  shellWriteTargets,
  archiveExtractTargets,
};
