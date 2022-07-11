import { Assignment, ButtonType, ButtonTypeData } from "midi-mixer-plugin"
import WaveLinkClient from "./WaveLinkClient"
import WebSocket from "ws"

// Give node.js Websocket superpowers
const wnd = globalThis as any
wnd.WebSocket = WebSocket

export interface Mixer {
  bgColor: string
  deltaLinked: number
  filters: Filter[]
  iconData: string
  inputType: number
  isAvailable: boolean
  isLinked: boolean
  isLocalInMuted: boolean
  isStreamInMuted: boolean
  localMixFilterBypass: boolean
  localVolumeIn: number
  mixId: string
  mixerName: string
  streamMixFilterBypass: boolean
  streamVolumeIn: number
}

export interface Filter {
  active: boolean
  filterID: string
  name: string
  pluginID: string
}

// NB: These are not the same as Mixer and I want to :knife:
export interface MixerFromEvent {
  channelPos: number
  mixerId: string
  name: string
  inputType: number
  localVolIn: number
  streamVolIn: number
  isLinked: boolean
  deltaLinked: number
  isLocalMuteIn: boolean
  isStreamMuteIn: boolean
  isAvailable: boolean
  isNotBlockedLocal: boolean
  isNotBlockedStream: boolean
  bgColor: string
  icon: string
  iconData: string
  filters: FilterFromEvent[]
  localMixFilterBypass: boolean
  streamMixFilterBypass: boolean
  topSlider: string
}

export interface FilterFromEvent {
  active: boolean
  filterID: string
  name: string
  pluginID: string
}

async function connectWithRetry(client: WaveLinkClient) {
  // NB: Every retry we move forward one port, 21 retries will
  // cycle the entire list twice
  let retries = 21

  while (retries > 0) {
    try {
      await client.tryToConnect()
      return false
    } catch (e) {
      client.reconnect()
      retries--

      if (retries < 0) throw e
    }
  }

  return false
}

function volumeMMToWaveLink(vol: number) {
  return Math.round(vol * 100.0)
}

function volumeWaveLinkToMM(vol: number) {
  return vol / 100.0
}

const mixerTypes = ["local", "stream"]
let mixerMap: Record<string, { mixer: Mixer; assignment: Assignment }>
const buttonList: Record<string, ButtonType> = {}

async function initialize() {
  const client = new WaveLinkClient("windows")

  // Leak client for debugging
  const wnd: any = globalThis
  wnd.waveLinkClient = client

  try {
    await connectWithRetry(client)
  } catch (e) {
    $MM.showNotification(`Couldn't connect to Wave Link software! ${e}`)
  }

  // Set up toggle buttons
  const createButton = (
    id: string,
    data: ButtonTypeData,
    pressed: (b: ButtonType) => unknown
  ) => {
    const btn = new ButtonType(id, data)
    btn.on("pressed", () => pressed(btn))
    buttonList[id] = btn
  }

  const createMixerAssignment = ( mixer: Mixer, type: string) =>
  {
    const name = `${mixer.mixId}_${type}`
    const friendlyType = type === "local" ? "Headphone" : "Stream"
    const isLocal = type === "local"

    const [muted, volume] = isLocal
      ? [mixer.isLocalInMuted, mixer.localVolumeIn]
      : [mixer.isStreamInMuted, mixer.streamVolumeIn]

    const assign = new Assignment(name, {
      name: `${mixer.mixerName} - ${friendlyType}`,
      muted,
      volume: volumeWaveLinkToMM(volume),
    })

    // Set volume even harder
    setTimeout(() => {
      assign.volume = volumeWaveLinkToMM(volume)
    }, 100)

    assign.on("volumeChanged", (level: number) => {
      client.setVolume(
        "input",
        mixer.mixId,
        type,
        volumeMMToWaveLink(level)
      )
      assign.volume = level
    })

    assign.on("mutePressed", () => {
      client.setMute("input", mixer.mixId, type)
      assign.muted = isLocal ? mixer.isLocalInMuted : mixer.isStreamInMuted
    })

    return {id: name, assignment: assign}
  }

  const createFilterButton = (mixer: Mixer, f: Filter) => {
    createButton(
      `${mixer.mixId}_${f.filterID}`,
      {
        name: `${f.name} on ${mixer.mixerName}`,
        active: f.active,
      },
      (b) => {
        client.setFilter(mixer.mixId, f.filterID)
        f.active = b.active
      }
    )
  }
  //
  // Set up fader assignments
  //

  mixerMap = (await client.getMixers()).reduce(
    (
      acc: Record<string, { mixer: Mixer; assignment: Assignment }>,
      mixer: Mixer
    ) => {
      // For each mixer, we create a fader for both the headphone and stream
      // output
      mixerTypes.forEach((type) => {
        var assign = createMixerAssignment(mixer, type)
        acc[assign.id] = { mixer, assignment: assign.assignment }
      })

      mixer.filters.forEach((f) => {
        createFilterButton(mixer, f)
      })

      return acc
    },
    {}
  )

  // Monitor mixer level changes from Wave Link and update the faders
  //
  // deviceId example: pcm_out_01_v_00_sd2
  // mixerId examples: pcm_out_01_v_00_sd2_local, pcm_out_01_v_00_sd2_stream
  client.event!.on("inputMixerChanged", (deviceId: string) => {
    const mixer: MixerFromEvent = client.getMixer(deviceId)

    const streamMixer = mixerMap[`${deviceId}_stream`]
    const localMixer = mixerMap[`${deviceId}_local`]

    localMixer.assignment.muted = mixer.isLocalMuteIn
    localMixer.assignment.volume = volumeWaveLinkToMM(mixer.localVolIn)
    streamMixer.assignment.muted = mixer.isStreamMuteIn
    streamMixer.assignment.volume = volumeWaveLinkToMM(mixer.streamVolIn)

    // Update filter buttons
    mixer.filters.forEach((f) => {
      buttonList[`${deviceId}_${f.filterID}`].active = f.active
    })
  })

  //
  // Set up Buttons
  //

  createButton(
    "toggleMonitorState",
    {
      name: "Toggle Monitor Mix / Stream Mix in Headphones",
      active: (await client.getSwitchState()) === "StreamMix",
    },
    async (b) => {
      const current = await client.getSwitchState()
      const newState = current === "StreamMix" ? "LocalMix" : "StreamMix"

      await client.changeSwitchState(newState)
      b.active = newState === "StreamMix"
    }
  )

  // Channel is added or deleted
  client.event!.on("channelsChanged", async () => {
    // Removing all assignments
    var mixerNames = Object.keys(mixerMap)
    mixerNames.forEach( (mixerName) => {
      mixerMap[mixerName].assignment.remove();
    })

    // Adding all assignments
    mixerMap = (await client.getMixers()).reduce(
      (
        acc: Record<string, { mixer: Mixer; assignment: Assignment }>,
        mixer: Mixer
      ) => {
        // For each mixer, we create a fader for both the headphone and stream
        // output
        mixerTypes.forEach((type) => {
          var assign = createMixerAssignment(mixer, type)
          acc[assign.id] = { mixer, assignment: assign.assignment }
        })
  
        mixer.filters.forEach((f) => {
          createFilterButton(mixer, f)
        })
  
        return acc
      },
      {}
    )

  });

  console.log(`Found ${Object.keys(mixerMap).length} mixers`)
  console.log(mixerMap)
}

initialize().then(() => console.log("started!"))

// NB: Without this, Midi Mixer immediately terminates
setInterval(() => {
  console.log("")
}, 1 * 60 * 60 * 1000)
