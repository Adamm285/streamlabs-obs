import { Service } from './core/service';
import { SettingsService } from './settings';
import * as obs from '../../obs-api';
import electron from 'electron';
import { Inject } from './core/injector';
import Utils from './utils';
import { WindowsService } from './windows';
import { ScalableRectangle } from '../util/ScalableRectangle';
import { Subscription } from 'rxjs';
import { SelectionService } from 'services/selection';

const { remote } = electron;

const DISPLAY_ELEMENT_POLLING_INTERVAL = 500;

export interface IDisplayOptions {
  sourceId?: string;
  paddingSize?: number;
  electronWindowId?: number;
  slobsWindowId?: string;
  paddingColor?: IRGBColor;
  renderingMode?: number;
}

export class Display {
  @Inject() settingsService: SettingsService;
  @Inject() videoService: VideoService;
  @Inject() windowsService: WindowsService;
  @Inject() selectionService: SelectionService;

  outputRegionCallbacks: Function[];
  outputRegion: IRectangle;
  isDestroyed = false;

  trackingInterval: number;
  currentPosition: IRectangle = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };

  electronWindow: Electron.BrowserWindow;
  slobsWindowId: string;

  private readonly selectionSubscription: Subscription;

  sourceId: string;
  renderingMode: number;

  boundDestroy: any;
  boundClose: any;
  displayDestroyed: boolean;

  focusListener: () => void;
  unfocusListener: () => void;
  movedListener: () => void;
  movedTimeout: number;

  constructor(public name: string, options: IDisplayOptions = {}) {
    this.sourceId = options.sourceId;
    const electronWindowId = options.electronWindowId || remote.getCurrentWindow().id;
    this.slobsWindowId = options.slobsWindowId || Utils.getCurrentUrlParams().windowId;
    this.renderingMode = options.renderingMode
      ? options.renderingMode
      : obs.ERenderingMode.OBS_MAIN_RENDERING;

    this.electronWindow = remote.BrowserWindow.fromId(electronWindowId);

    this.videoService.createOBSDisplay(electronWindowId, name, this.renderingMode, this.sourceId);

    this.displayDestroyed = false;

    // grid lines are enabled by default
    // switch them off multiple items are selected
    if (this.selectionService.getSize() > 1) {
      this.switchGridlines(false);
    }

    // also sync girdlines when selection changes
    this.selectionSubscription = this.selectionService.updated.subscribe(state => {
      this.switchGridlines(state.selectedIds.length <= 1);
    });

    if (options.paddingColor) {
      this.videoService.setOBSDisplayPaddingColor(
        name,
        options.paddingColor.r,
        options.paddingColor.g,
        options.paddingColor.b,
      );
    } else {
      this.videoService.setOBSDisplayPaddingColor(name, 11, 22, 28);
    }

    if (options.paddingSize != null) {
      this.videoService.setOBSDisplayPaddingSize(name, options.paddingSize);
    }

    this.outputRegionCallbacks = [];

    this.boundClose = this.remoteClose.bind(this);

    this.electronWindow.on('close', this.boundClose);

    // this.electronWindow.on('moved', (e: Electron.Event, newBounds: Electron.Rectangle) => {
    //   console.log('MOVED');
    //   this.hidden = false;
    //   this.trackingFun();
    // });

    // MAC-TODO: Clean all this up
    this.focusListener = () => this.setFocused(true);
    this.unfocusListener = () => this.setFocused(false);

    document.addEventListener('mousedown', this.focusListener);
    this.electronWindow.on('focus', this.focusListener);
    this.electronWindow.on('blur', this.unfocusListener);

    this.movedListener = () => {
      // We already knew about this move from the listeners in the TitleBar component,
      // so we don't need to handle it here.
      if (window['moveInProgress']) return;

      if (!this.windowsService.state[this.slobsWindowId].hideStyleBlockers) {
        this.windowsService.updateStyleBlockers(this.slobsWindowId, true);
      }

      if (this.movedTimeout) {
        clearTimeout(this.movedTimeout);
      }

      this.movedTimeout = window.setTimeout(() => {
        this.windowsService.updateStyleBlockers(this.slobsWindowId, false);
      }, 500);
    };

    this.electronWindow.on('moved', this.movedListener);
  }

  trackingFun: () => void;

  /**
   * Will keep the display positioned on top of the passed HTML element
   * @param element the html element to host the display
   */
  trackElement(element: HTMLElement) {
    if (this.trackingInterval) clearInterval(this.trackingInterval);

    this.trackingFun = () => {
      const rect = this.getScaledRectangle(element.getBoundingClientRect());

      if (
        rect.x !== this.currentPosition.x ||
        rect.y !== this.currentPosition.y ||
        rect.width !== this.currentPosition.width ||
        rect.height !== this.currentPosition.height
      ) {
        this.videoService.setOBSDisplayScale(
          this.name,
          this.windowsService.state[this.slobsWindowId].scaleFactor,
        );
        this.move(rect.x, rect.y);
        this.resize(rect.width, rect.height);
      }
    };

    this.trackingFun();
    this.trackingInterval = window.setInterval(this.trackingFun, DISPLAY_ELEMENT_POLLING_INTERVAL);
  }

  getScaledRectangle(rect: ClientRect): IRectangle {
    const factor: number = this.windowsService.state[this.slobsWindowId].scaleFactor;

    // MAC-TODO: Window bounds are only taken into account on mac
    const winBounds = this.electronWindow.getBounds();

    return {
      x: winBounds.x + rect.left, // * factor,
      y: winBounds.y + rect.bottom, // * factor,
      width: rect.width, // * factor,
      height: rect.height, // * factor,
    };
  }

  move(x: number, y: number) {
    this.currentPosition.x = x;
    this.currentPosition.y = y;
    this.videoService.moveOBSDisplay(this.name, x, y);
  }

  resize(width: number, height: number) {
    this.currentPosition.width = width;
    this.currentPosition.height = height;
    this.videoService.resizeOBSDisplay(this.name, width, height);
    if (this.outputRegionCallbacks.length) this.refreshOutputRegion();
  }

  remoteClose() {
    this.outputRegionCallbacks = [];
    if (this.trackingInterval) clearInterval(this.trackingInterval);
    if (this.selectionSubscription) this.selectionSubscription.unsubscribe();
    if (!this.displayDestroyed) {
      this.videoService.destroyOBSDisplay(this.name);
      this.displayDestroyed = true;
    }
  }

  destroy() {
    const win = this.electronWindow;
    if (win) {
      win.removeListener('close', this.boundClose);
      win.removeListener('focus', this.focusListener);
      win.removeListener('blur', this.unfocusListener);
      win.removeListener('moved', this.movedListener);
    }
    document.removeEventListener('mousedown', this.focusListener);
    this.remoteClose();
  }

  onOutputResize(cb: (region: IRectangle) => void) {
    this.outputRegionCallbacks.push(cb);
  }

  refreshOutputRegion() {
    const position = this.videoService.getOBSDisplayPreviewOffset(this.name);
    const size = this.videoService.getOBSDisplayPreviewSize(this.name);

    this.outputRegion = {
      ...position,
      ...size,
    };

    this.outputRegionCallbacks.forEach(cb => {
      cb(this.outputRegion);
    });
  }

  drawingUI = true;

  setShoulddrawUI(drawUI: boolean) {
    this.drawingUI = drawUI;
    this.videoService.setOBSDisplayShouldDrawUI(this.name, drawUI);
  }

  switchGridlines(enabled: boolean) {
    // This function does nothing if we aren't drawing the UI
    if (!this.drawingUI) return;
    this.videoService.setOBSDisplayDrawGuideLines(this.name, enabled);
  }

  setFocused(focus: boolean) {
    console.log('FOCUS', focus);
    this.videoService.setOBSDisplayFocused(this.name, focus);
  }
}

export class VideoService extends Service {
  @Inject() settingsService: SettingsService;

  init() {
    this.settingsService.loadSettingsIntoStore();
  }

  // Generates a random string:
  // https://gist.github.com/6174/6062387
  getRandomDisplayId() {
    return (
      Math.random()
        .toString(36)
        .substring(2, 15) +
      Math.random()
        .toString(36)
        .substring(2, 15)
    );
  }

  getScreenRectangle() {
    return new ScalableRectangle({
      x: 0,
      y: 0,
      width: this.baseWidth,
      height: this.baseHeight,
    });
  }

  get baseWidth() {
    return this.baseResolution.width;
  }

  get baseHeight() {
    return this.baseResolution.height;
  }

  get baseResolution() {
    const [widthStr, heightStr] = this.settingsService.state.Video.Base.split('x');
    const width = parseInt(widthStr, 10);
    const height = parseInt(heightStr, 10);

    return {
      width,
      height,
    };
  }

  setBaseResolution(resolution: { width: number; height: number }) {
    this.settingsService.setSettingValue(
      'Video',
      'Base',
      `${resolution.width}x${resolution.height}`,
    );
  }

  /**
   * @warning DO NOT USE THIS METHOD. Use the Display class instead
   */
  createOBSDisplay(
    electronWindowId: number,
    name: string,
    remderingMode: number,
    sourceId?: string,
  ) {
    const electronWindow = remote.BrowserWindow.fromId(electronWindowId);

    if (sourceId) {
      obs.NodeObs.OBS_content_createSourcePreviewDisplay(
        electronWindow.getNativeWindowHandle(),
        sourceId,
        name,
      );
    } else {
      obs.NodeObs.OBS_content_createDisplay(
        electronWindow.getNativeWindowHandle(),
        name,
        remderingMode,
      );
      const nwr = electron.remote.require('node-window-rendering');
      nwr.createWindow(obs.NodeObs.OBS_content_createIOSurface());
    }
  }

  setOBSDisplayPaddingColor(name: string, r: number, g: number, b: number) {
    obs.NodeObs.OBS_content_setPaddingColor(name, r, g, b);
  }

  setOBSDisplayPaddingSize(name: string, size: number) {
    obs.NodeObs.OBS_content_setPaddingSize(name, size);
  }

  moveOBSDisplay(name: string, x: number, y: number) {
    obs.NodeObs.OBS_content_moveDisplay(name, x, y);
  }

  resizeOBSDisplay(name: string, width: number, height: number) {
    obs.NodeObs.OBS_content_resizeDisplay(name, width, height);
  }

  destroyOBSDisplay(name: string) {
    obs.NodeObs.OBS_content_destroyDisplay(name);
  }

  getOBSDisplayPreviewOffset(name: string): IVec2 {
    return obs.NodeObs.OBS_content_getDisplayPreviewOffset(name);
  }

  getOBSDisplayPreviewSize(name: string): { width: number; height: number } {
    return obs.NodeObs.OBS_content_getDisplayPreviewSize(name);
  }

  setOBSDisplayShouldDrawUI(name: string, drawUI: boolean) {
    obs.NodeObs.OBS_content_setShouldDrawUI(name, drawUI);
  }

  setOBSDisplayDrawGuideLines(name: string, drawGuideLines: boolean) {
    obs.NodeObs.OBS_content_setDrawGuideLines(name, drawGuideLines);
  }

  setOBSDisplayFocused(name: string, focus: boolean) {
    obs.NodeObs.OBS_content_setFocused(name, focus);
  }

  setOBSDisplayScale(name: string, scaleFactor: number) {
    obs.NodeObs.OBS_content_setDisplayScale(name, scaleFactor);
  }
}
