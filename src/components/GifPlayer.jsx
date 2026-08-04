/**
 * GifPlayer — GIF 动图播放器（Canvas 逐帧）。
 * 共享实现见 FrameAnimPlayer，这里只传入 GIF 侧差异开关。
 */
import FrameAnimPlayer from './FrameAnimPlayer.jsx';

export default function GifPlayer(props) {
  return (
    <FrameAnimPlayer
      {...props}
      progressBar="circle"
      stallTimeout={90000}
      debounceToggle
      handleTouch
      pauseHint={false}
      capByMaxHeight
      capWidthByCanvas={false}
      clearCacheOnError={false}
      cssPrefix="gif"
    />
  );
}
