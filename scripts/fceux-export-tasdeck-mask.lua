local output_filename = os.getenv("TASDECK_MASK_OUTPUT")
local trace_filename = os.getenv("TASDECK_MASK_TRACE_OUTPUT")
local completion_filename = os.getenv("TASDECK_MASK_COMPLETION_OUTPUT")

if output_filename == nil or output_filename == "" then
  error("TASDECK_MASK_OUTPUT must be set")
end

if trace_filename == nil or trace_filename == "" then
  trace_filename = output_filename .. ".trace.csv"
end

if completion_filename == nil or completion_filename == "" then
  error("TASDECK_MASK_COMPLETION_OUTPUT must be set")
end

if memory.registerread == nil or memory.registerwrite == nil then
  error("FCEUX memory.registerread/registerwrite hooks are required for poll-accurate export")
end

local output = assert(io.open(output_filename, "wb"))
local trace_output = assert(io.open(trace_filename, "w"))
local movie_loaded = false
local movie_length = 0
local current_movie_frame = -1
local written_polls = 0
local strobe_falls = 0
local incomplete_reads = 0
local ignored_reads = 0
local strobe_high = false
local observed_mismatches = 0
local intra_frame_mismatches = 0

-- Versioned two-controller TASDeck header: magic, version, port count, CRLF,
-- then the source movie's total video-frame count (big-endian uint32, lag
-- frames included) so TASDeck can time the run exactly. The count is not known
-- until the movie loads, so write zero (meaning "unknown") now and seek back
-- to fill it in at completion. Payload bytes are interleaved per frame:
-- p1, p2, p1, p2, ...
output:write("TD2P")
output:write(string.char(2, 2, 13, 10))
output:write(string.char(0, 0, 0, 0))

local function backfill_movie_frame_count()
  if movie_length <= 0 then
    return
  end
  output:seek("set", 8)
  output:write(string.char(
    math.floor(movie_length / 0x1000000) % 256,
    math.floor(movie_length / 0x10000) % 256,
    math.floor(movie_length / 0x100) % 256,
    movie_length % 256
  ))
  output:seek("end", 0)
end

local ports = {
  [1] = {
    address = 0x4016,
    capturing = false,
    read_index = 0,
    pending_mask = 0,
    observed_mask = 0,
    observed_has_value = false,
  },
  [2] = {
    address = 0x4017,
    capturing = false,
    read_index = 0,
    pending_mask = 0,
    observed_mask = 0,
    observed_has_value = false,
  },
}

-- The output is one two-byte record per movie frame that completes at least
-- one controller poll. Games may poll both ports at different times within the
-- frame, so emission is deferred until FCEUX advances to the next movie frame.
local written_frames = 0
local frame_has_poll = false
local frame_mask1 = 0
local frame_mask2 = 0

trace_output:write("poll_index,movie_frame,strobe_index,port,mask1_hex,mask2_hex,observed_hex,observed_valid,mismatch,incomplete_reads,ignored_reads,total_mismatches\n")

local function input_to_byte(input)
  local value = 0

  if input.right then value = value + 128 end
  if input.left then value = value + 64 end
  if input.down then value = value + 32 end
  if input.up then value = value + 16 end
  if input.start then value = value + 8 end
  if input.select then value = value + 4 end
  if input.B then value = value + 2 end
  if input.A then value = value + 1 end

  return value
end

local function current_masks()
  return input_to_byte(joypad.get(1)), input_to_byte(joypad.get(2))
end

local function reset_read(port_index)
  local port = ports[port_index]
  local mask1, mask2 = current_masks()

  port.capturing = true
  port.read_index = 0
  port.pending_mask = port_index == 1 and mask1 or mask2
  port.observed_mask = 0
  port.observed_has_value = false
end

local function finish_partial_read(port_index)
  local port = ports[port_index]
  if port.read_index > 0 and port.read_index < 8 then
    incomplete_reads = incomplete_reads + 1
  end

  port.capturing = false
  port.read_index = 0
  port.pending_mask = 0
  port.observed_mask = 0
  port.observed_has_value = false
end

local function finish_all_partial_reads()
  finish_partial_read(1)
  finish_partial_read(2)
end

local function flush_frame()
  if frame_has_poll then
    output:write(string.char(frame_mask1))
    output:write(string.char(frame_mask2))
    written_frames = written_frames + 1
  end

  frame_has_poll = false
  frame_mask1 = 0
  frame_mask2 = 0
end

local function begin_movie_frame(frame_number)
  if current_movie_frame ~= -1 and frame_number ~= current_movie_frame then
    flush_frame()
  end

  current_movie_frame = frame_number
end

local function note_completed_poll(port_index, mismatch)
  local mask1, mask2 = current_masks()

  if not frame_has_poll then
    frame_has_poll = true
    frame_mask1 = mask1
    frame_mask2 = mask2
  elseif mask1 ~= frame_mask1 or mask2 ~= frame_mask2 then
    intra_frame_mismatches = intra_frame_mismatches + 1
  end

  trace_output:write(string.format(
    "%d,%d,%d,%d,%02X,%02X,%s,%d,%d,%d,%d,%d\n",
    written_polls,
    current_movie_frame,
    strobe_falls,
    port_index,
    mask1,
    mask2,
    ports[port_index].observed_has_value and string.format("%02X", ports[port_index].observed_mask) or "",
    ports[port_index].observed_has_value and 1 or 0,
    mismatch and 1 or 0,
    incomplete_reads,
    ignored_reads,
    observed_mismatches
  ))

  written_polls = written_polls + 1
end

local function finish(reason)
  finish_all_partial_reads()
  flush_frame()
  memory.registerread(0x4016, nil)
  memory.registerread(0x4017, nil)
  memory.registerwrite(0x4016, nil)
  backfill_movie_frame_count()
  output:close()
  trace_output:close()
  local completion_output = assert(io.open(completion_filename, "w"))
  completion_output:write(string.format(
    "complete frames=%d polls=%d reason=%s\n",
    written_frames,
    written_polls,
    reason
  ))
  completion_output:close()
  print(string.format(
    "TASDeck two-controller mask export complete: output=%s trace=%s movie_frames=%d polled_frames=%d polls=%d strobes=%d incomplete=%d ignored_reads=%d mismatches=%d intra_frame_mismatches=%d reason=%s",
    output_filename,
    trace_filename,
    movie_length,
    written_frames,
    written_polls,
    strobe_falls,
    incomplete_reads,
    ignored_reads,
    observed_mismatches,
    intra_frame_mismatches,
    reason
  ))
  if intra_frame_mismatches > 0 then
    print(string.format(
      "WARNING: %d completed poll(s) saw masks differ within one movie frame; latch-window playback serves the first masks for that frame",
      intra_frame_mismatches
    ))
  end
  -- FCEUX's macOS Qt build can occasionally report SIGSEGV while tearing down
  -- after os.exit even though Lua has closed both outputs. The wrapper trusts
  -- only the completion marker written above and validates the files before
  -- treating that specific post-completion failure as recoverable.
  os.exit(0)
end

local function on_4016_write(address, size, value)
  local next_strobe_high = value % 2 == 1

  if strobe_high and not next_strobe_high then
    finish_all_partial_reads()
    strobe_falls = strobe_falls + 1
    reset_read(1)
    reset_read(2)
  elseif next_strobe_high then
    finish_all_partial_reads()
  end

  strobe_high = next_strobe_high
end

local function on_controller_read(port_index, value)
  local port = ports[port_index]
  if not port.capturing or strobe_high then
    ignored_reads = ignored_reads + 1
    return
  end

  if value ~= nil then
    port.observed_has_value = true
    if value % 2 == 1 then
      port.observed_mask = port.observed_mask + 2 ^ port.read_index
    end
  end

  port.read_index = port.read_index + 1
  if port.read_index == 8 then
    local mismatch = port.observed_has_value and port.observed_mask ~= port.pending_mask
    if mismatch then
      observed_mismatches = observed_mismatches + 1
    end

    note_completed_poll(port_index, mismatch)

    port.capturing = false
    port.read_index = 0
    port.pending_mask = 0
    port.observed_mask = 0
    port.observed_has_value = false
  end
end

memory.registerwrite(0x4016, on_4016_write)
memory.registerread(0x4016, function(address, size, value)
  on_controller_read(1, value)
end)
memory.registerread(0x4017, function(address, size, value)
  on_controller_read(2, value)
end)

FCEU.speedmode("maximum")

while true do
  if movie.active() then
    if not movie_loaded then
      movie.playbeginning()
      movie_length = movie.length()
      movie_loaded = true
      print(string.format(
        "TASDeck two-controller mask export started: movie=%s frames=%d output=%s",
        movie.getname(),
        movie_length,
        output_filename
      ))
    end

    local frame_number = movie.framecount()
    begin_movie_frame(frame_number)

    if frame_number >= movie_length then
      finish("movie_length")
    end
  elseif movie_loaded then
    finish("movie_inactive")
  end

  FCEU.frameadvance()
end
