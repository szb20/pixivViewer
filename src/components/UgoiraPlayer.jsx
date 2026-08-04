/**
 * UgoiraPlayer — Ugoira 动图播放器（Canvas 逐帧）。
 * 共享实现见 FrameAnimPlayer，这里只传入 Ugoira 侧差异开关。
 */
import FrameAnimPlayer from './FrameAnimPlayer.jsx';

export default function UgoiraPlayer(props) {
  return (
    <FrameAnimPlayer
      {...props}
      progressBar="bar"
      stallTimeout={0}
      debounceToggle={false}
      handleTouch={false}
      pauseHint
      capByMaxHeight={false}
      capWidthByCanvas
      clearCacheOnError
      cssPrefix="ugoira"
    />
  );
}
