// 上游解析接口（/api/v/resolve 等）的响应是“挤牙膏”式 JSON 流：整包 700KB~1.8MB，
// 按 ~1KB 左右的分片陆续到达，6~9 秒才结束。这里必须“边到边”解析出完整线路对象，
// 详情页才能在第一/第二条线路到达时就把多线路快照发出去，而不是等整包。
//
// 旧实现把所有分片拼进一个不断增长的字符串（`json += fragment`），再用下标逐字符
// 扫描。V8 的字符串拼接本身只产生 ConsString（廉价），但按下标访问会强制把整条
// ConsString 拉平成普通字符串；于是每来一片都要重新拉平一次已经收到的全部内容 ——
// 总开销 = O(分片数 × 总长度)。1.8MB / 1KB ≈ 1800 片，线上实测单请求因此烧掉
// 700~1600ms CPU，直接把同一个 isolate 上的邻近请求拖成 503
// （Worker exceeded CPU time limit）。
//
// 这里改成按分片列表扫描：字符用 (chunkIndex, offset) 游标顺序读取，绝不重复拉平；
// 只有“某个元素收齐”或“需要整包兜底解析”时才拼接对应区间。整体 O(总长度)。
export function createResolverVariantParser() {
  const chunks = [];
  const chunkStarts = [];
  let totalLength = 0;

  // 寻找 "variants"/"sources"/... 键用的小窗口：只保留尚未匹配的尾部，
  // 避免为了正则反复拼接整个前缀。
  let searchBuffer = "";
  let searchBase = 0;
  // 已经匹配到 "variants"/"sources"/... 这个键（还没等到后面的 "["）。
  // 键和 "[" 可能落在不同的分片里，必须跨 push 记住进度，否则永远找不到数组。
  let arrayKeySeen = false;

  let arrayStart = -1;
  let arrayComplete = false;

  // 扫描游标：curAbs 是当前字符的绝对下标，curCi/curOff 指向 chunks 里的位置。
  let curCi = 0;
  let curOff = 0;
  let curAbs = 0;

  let inString = false;
  let escaped = false;
  let elementStartAbs = -1;
  let elementDepth = 0;

  const variants = [];

  let flat = null;
  let flatLength = -1;

  const locate = (abs) => {
    let low = 0;
    let high = chunkStarts.length - 1;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (chunkStarts[mid] <= abs) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return { ci: best, off: abs - chunkStarts[best] };
  };

  // 只在“元素收齐 / 整包兜底 / 数组闭合”时调用，拼接长度合计为 O(总长度)。
  const sliceRange = (fromAbs, toAbsExclusive) => {
    if (toAbsExclusive <= fromAbs) return "";
    const from = locate(fromAbs);
    const to = locate(toAbsExclusive - 1);
    if (from.ci === to.ci) {
      return chunks[from.ci].slice(from.off, to.off + 1);
    }
    let out = chunks[from.ci].slice(from.off);
    for (let index = from.ci + 1; index < to.ci; index += 1) out += chunks[index];
    out += chunks[to.ci].slice(0, to.off + 1);
    return out;
  };

  const fullText = () => {
    if (flat === null || flatLength !== totalLength) {
      flat = chunks.join("");
      flatLength = totalLength;
    }
    return flat;
  };

  const reposition = (abs) => {
    const loc = locate(abs);
    curCi = loc.ci;
    curOff = loc.off;
    curAbs = abs;
  };

  const findArrayStart = () => {
    if (arrayStart >= 0) return;
    // 一次 push 里可能同时含“不合适的键 + 真正的键”，要一直找到数组或数据用尽。
    while (true) {
      if (!arrayKeySeen) {
        const pattern = /"(?:variants|sources|videos|streams)"\s*:/g;
        const match = pattern.exec(searchBuffer);
        if (!match) {
          // 保留尾部 64 字符（键名 + 空白最长远小于 64），避免重复扫描前缀。
          if (searchBuffer.length > 64) {
            const drop = searchBuffer.length - 64;
            searchBuffer = searchBuffer.slice(drop);
            searchBase += drop;
          }
          return;
        }
        const consumed = pattern.lastIndex;
        searchBuffer = searchBuffer.slice(consumed);
        searchBase += consumed;
        arrayKeySeen = true;
      }
      const nonWhitespace = searchBuffer.search(/\S/);
      if (nonWhitespace < 0) {
        // 全是空白：可以整体丢掉，等后续分片。
        searchBase += searchBuffer.length;
        searchBuffer = "";
        return;
      }
      if (nonWhitespace > 0) {
        searchBuffer = searchBuffer.slice(nonWhitespace);
        searchBase += nonWhitespace;
      }
      if (searchBuffer[0] !== "[") {
        // 这个键后面不是数组（例如 "videos": 8），跳过该字符继续找下一个键。
        searchBuffer = searchBuffer.slice(1);
        searchBase += 1;
        arrayKeySeen = false;
        continue;
      }
      arrayStart = searchBase;
      searchBuffer = searchBuffer.slice(1);
      searchBase = arrayStart + 1;
      reposition(arrayStart + 1);
      return;
    }
  };

  const scan = () => {
    findArrayStart();
    if (arrayStart < 0 || arrayComplete) return;
    while (true) {
      while (curCi < chunks.length && curOff >= chunks[curCi].length) {
        curCi += 1;
        curOff = 0;
      }
      if (curCi >= chunks.length) return;
      const char = chunks[curCi][curOff];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        curOff += 1;
        curAbs += 1;
        continue;
      }
      if (char === '"') {
        inString = true;
        curOff += 1;
        curAbs += 1;
        continue;
      }
      if (elementStartAbs < 0) {
        if (char === "]") {
          arrayComplete = true;
          try {
            const complete = JSON.parse(sliceRange(arrayStart, curAbs + 1));
            if (Array.isArray(complete)) {
              variants.splice(0, variants.length, ...complete);
            }
          } catch {
            // 已经收集到的对象仍可用。
          }
          break;
        }
        if (char === "{") {
          elementStartAbs = curAbs;
          elementDepth = 1;
        }
      } else if (char === "{" || char === "[") {
        elementDepth += 1;
      } else if (char === "}" || char === "]") {
        elementDepth -= 1;
        if (elementDepth === 0) {
          try {
            variants.push(JSON.parse(sliceRange(elementStartAbs, curAbs + 1)));
          } catch {
            // 半截或非对象元素直接跳过。
          }
          elementStartAbs = -1;
        }
      }
      curOff += 1;
      curAbs += 1;
    }
  };

  return {
    push(fragment) {
      if (!fragment) return;
      chunkStarts.push(totalLength);
      chunks.push(fragment);
      totalLength += fragment.length;
      if (arrayStart < 0) searchBuffer += fragment;
      scan();
    },
    variants() {
      return variants.slice();
    },
    // 只回条数，避免每次 push 都为了“有没有新增”复制一遍数组。
    count() {
      return variants.length;
    },
    complete() {
      return arrayComplete;
    },
    payload() {
      if (variants.length || arrayComplete) {
        return { variants: variants.slice() };
      }
      try {
        return JSON.parse(fullText());
      } catch {
        return null;
      }
    },
  };
}
