export interface Utf8Slice {
  text: string;
  totalBytes: number;
  nextOffset?: number;
}

export function sliceUtf8(value: string, offset: number, limit: number): Utf8Slice {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const data = Buffer.from(value, "utf8");
  if (offset > data.length) throw new Error(`offset ${offset} exceeds response size ${data.length}`);
  if (offset < data.length && isContinuation(data[offset]!)) {
    throw new Error(`offset ${offset} is not a UTF-8 character boundary`);
  }

  let end = Math.min(data.length, offset + limit);
  while (end < data.length && isContinuation(data[end]!)) end -= 1;
  if (end === offset && end < data.length) {
    end += 1;
    while (end < data.length && isContinuation(data[end]!)) end += 1;
  }

  const slice: Utf8Slice = {
    text: data.subarray(offset, end).toString("utf8"),
    totalBytes: data.length,
  };
  if (end < data.length) slice.nextOffset = end;
  return slice;
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
