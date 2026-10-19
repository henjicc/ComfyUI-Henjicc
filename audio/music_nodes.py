"""V3 model-independent audio mixing."""

from comfy_api.latest import io

from .music import mix_audio


class HenjiccAudioMix(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(node_id="HenjiccAudioMix", display_name="Vocal and Backing Mix", category="Henjicc/Audio",
                         inputs=[io.Audio.Input("vocals"), io.Audio.Input("backing"),
                                 io.Float.Input("vocal_gain_db", default=0, min=-24, max=12, step=.5),
                                 io.Float.Input("backing_gain_db", default=0, min=-24, max=12, step=.5),
                                 io.Float.Input("vocal_offset", default=0, min=-30, max=30, step=.01)],
                         outputs=[io.Audio.Output("audio")])

    @classmethod
    def execute(cls, vocals, backing, vocal_gain_db, backing_gain_db, vocal_offset):
        return io.NodeOutput(mix_audio(vocals, backing, vocal_gain_db, backing_gain_db, vocal_offset))
