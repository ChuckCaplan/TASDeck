local output_filename = os.getenv("TASDECK_MASK_OUTPUT")
local trace_filename = os.getenv("TASDECK_MASK_TRACE_OUTPUT")
local completion_filename = os.getenv("TASDECK_MASK_COMPLETION_OUTPUT")

local output = nil
local trace_output = nil

local function required_environment(name, value)
  if value == nil or value == "" then
    error(name .. " must be set")
  end
end

local function close_outputs()
  if output ~= nil then
    output:close()
    output = nil
  end
  if trace_output ~= nil then
    trace_output:close()
    trace_output = nil
  end
end

local button_bits = {
  { name = "A", value = 1 },
  { name = "B", value = 2 },
  { name = "Select", value = 4 },
  { name = "Start", value = 8 },
  { name = "Up", value = 16 },
  { name = "Down", value = 32 },
  { name = "Left", value = 64 },
  { name = "Right", value = 128 },
}

local function input_to_byte(input, controller)
  local value = 0
  local prefix = "P" .. controller .. " "

  for _, button in ipairs(button_bits) do
    if input[prefix .. button.name] == true then
      value = value + button.value
    end
  end

  return value
end

local function run_export()
  required_environment("TASDECK_MASK_OUTPUT", output_filename)
  required_environment("TASDECK_MASK_TRACE_OUTPUT", trace_filename)
  required_environment("TASDECK_MASK_COMPLETION_OUTPUT", completion_filename)

  while not movie.isloaded() do
    emu.yield()
  end

  if emu.getsystemid() ~= "NES" then
    error("BizHawk must have an NES ROM loaded; loaded system is " .. emu.getsystemid())
  end

  movie.setreadonly(true)
  if not movie.play_from_start() then
    error("BizHawk could not restart the loaded movie from frame 0")
  end

  local movie_length = movie.length()
  if movie_length <= 0 then
    error("loaded BizHawk movie has no input frames")
  end

  output = assert(io.open(output_filename, "wb"))
  trace_output = assert(io.open(trace_filename, "w"))
  output:write("TD2P")
  output:write(string.char(1, 2, 13, 10))
  trace_output:write("frame_index,source_frame,mask1_hex,mask2_hex,source_format\n")

  local written_frames = 0
  local lag_frames = 0
  local reset_frames = 0
  local power_frames = 0

  client.speedmode(6400)
  client.unpause()
  print(string.format(
    "TASDeck BizHawk export started: movie=%s frames=%d output=%s",
    movie.filename(),
    movie_length,
    output_filename
  ))

  while true do
    emu.frameadvance()

    local frame_count = emu.framecount()
    if frame_count > 0 and frame_count <= movie_length then
      local movie_frame = frame_count - 1
      local input = movie.getinput(movie_frame)
      if input == nil then
        error("BizHawk returned no movie input for frame " .. movie_frame)
      end

      if input["Reset"] == true then
        reset_frames = reset_frames + 1
        print(string.format("WARNING: Reset occurs on movie frame %d", movie_frame))
      end
      if input["Power"] == true then
        power_frames = power_frames + 1
        print(string.format("WARNING: Power occurs on movie frame %d", movie_frame))
      end

      if emu.islagged() then
        lag_frames = lag_frames + 1
      else
        local mask1 = input_to_byte(input, 1)
        local mask2 = input_to_byte(input, 2)
        output:write(string.char(mask1, mask2))
        trace_output:write(string.format(
          "%d,%d,%02X,%02X,bk2\n",
          written_frames,
          movie_frame,
          mask1,
          mask2
        ))
        written_frames = written_frames + 1
      end
    end

    if frame_count >= movie_length or movie.mode() == "FINISHED" then
      close_outputs()
      local completion = assert(io.open(completion_filename, "w"))
      completion:write(string.format(
        "complete frames=%d movie_frames=%d lag_frames=%d reset_frames=%d power_frames=%d\n",
        written_frames,
        movie_length,
        lag_frames,
        reset_frames,
        power_frames
      ))
      completion:close()
      print(string.format(
        "TASDeck BizHawk export complete: movie_frames=%d polled_frames=%d lag_frames=%d resets=%d powers=%d output=%s trace=%s",
        movie_length,
        written_frames,
        lag_frames,
        reset_frames,
        power_frames,
        output_filename,
        trace_filename
      ))
      return
    end
  end
end

local ok, message = xpcall(run_export, debug.traceback)
if ok then
  client.exitCode(0)
else
  pcall(close_outputs)
  if output_filename ~= nil and output_filename ~= "" then
    os.remove(output_filename)
  end
  if trace_filename ~= nil and trace_filename ~= "" then
    os.remove(trace_filename)
  end
  if completion_filename ~= nil and completion_filename ~= "" then
    local completion = io.open(completion_filename, "w")
    if completion ~= nil then
      completion:write("error " .. tostring(message) .. "\n")
      completion:close()
    end
  end
  print("TASDeck BizHawk export failed: " .. tostring(message))
  client.exitCode(1)
end
