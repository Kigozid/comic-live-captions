/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { MotionComicVideo } from './MotionComicVideo.js';
import type { MotionComicVideoProps } from '../types.js';
import {
  DEFAULT_CAMERA,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_FALLBACK_PLACEMENT,
  DEFAULT_TRANSITIONS,
} from '../defaults.js';
import { durationInFrames } from '../timing.js';
import { assertValidVideoComposition } from '../validate.js';
import { MOTION_COMIC_COMPOSITION_ID } from './composition-id.js';

export { MOTION_COMIC_COMPOSITION_ID };

/** Remotion's Composition generics require an index signature. */
type CompositionProps = MotionComicVideoProps & Record<string, unknown>;

export const defaultMotionComicProps: CompositionProps = Object.freeze({
  pages: [
    {
      id: 'page-1',
      imageUrl: '',
      width: 1280,
      height: 1920,
      startSeconds: 0,
      endSeconds: 5,
      bubbles: [],
    },
  ],
  audioUrl: '',
  cues: [],
  width: 1280,
  height: 720,
  fps: 24,
  durationSeconds: 5,
  captionStyle: DEFAULT_CAPTION_STYLE,
  camera: DEFAULT_CAMERA,
  transitions: DEFAULT_TRANSITIONS,
  fallbackPlacement: DEFAULT_FALLBACK_PLACEMENT,
  backgroundColor: '#000000',
});

export const calculateMotionComicMetadata: CalculateMetadataFunction<
  CompositionProps
> = ({ props }) => {
  // Fail early in Studio/SSR when the job payload is malformed.
  if (props.audioUrl || (props.pages?.length && props.pages[0]?.imageUrl)) {
    assertValidVideoComposition(props as MotionComicVideoProps);
  }
  return {
    width: props.width,
    height: props.height,
    fps: props.fps,
    durationInFrames: durationInFrames(props.durationSeconds, props.fps),
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={MOTION_COMIC_COMPOSITION_ID}
      component={
        MotionComicVideo as unknown as React.FC<Record<string, unknown>>
      }
      durationInFrames={durationInFrames(
        defaultMotionComicProps.durationSeconds,
        defaultMotionComicProps.fps,
      )}
      fps={defaultMotionComicProps.fps}
      width={defaultMotionComicProps.width}
      height={defaultMotionComicProps.height}
      defaultProps={defaultMotionComicProps}
      calculateMetadata={
        calculateMotionComicMetadata as unknown as CalculateMetadataFunction<
          Record<string, unknown>
        >
      }
    />
  );
};
