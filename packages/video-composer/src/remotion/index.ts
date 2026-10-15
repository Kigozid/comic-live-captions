import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root.js';

registerRoot(RemotionRoot);

export { MotionComicVideo } from './MotionComicVideo.js';
export {
  MOTION_COMIC_COMPOSITION_ID,
  RemotionRoot,
  calculateMotionComicMetadata,
  defaultMotionComicProps,
} from './Root.js';
export { MOTION_COMIC_COMPOSITION_ID as COMPOSITION_ID } from './composition-id.js';
