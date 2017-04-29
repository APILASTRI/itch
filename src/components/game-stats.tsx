
import * as React from "react";
import {connect, I18nProps} from "./connect";
import {createSelector} from "reselect";
import {findWhere} from "underscore";

import interleave from "./interleave";

import platformData from "../constants/platform-data";
import actionForGame from "../util/action-for-game";

import format from "../util/format";

import TimeAgo from "./basics/time-ago";
import Icon from "./basics/icon";
import TotalPlaytime from "./total-playtime";
import LastPlayed from "./last-played";

import {
  IAppState, IUserMarketState,
  IGameRecord, ICaveRecord, IDownloadKey,
} from "../types";

import styled from "./styles";

const GameStatsDiv = styled.div`
  display: flex;
  flex-direction: column;
  font-size: 14px;
  color: $secondary-text-color;
  padding: 16px 0;
  line-height: 1.8;
  flex-shrink: 0;

  div {
    margin-right: 12px;
  }

  label {
    color: #B3B2B7; // FIXME: exceptions bad

    .nice-ago {
      color: $secondary-text-color; // sigh
    }

    &.original-price {
      text-decoration: line-through;
      color: inherit;
    }
  }

  .total-playtime .icon {
    margin: 0 3px;
  }

  .total-playtime, .last-playthrough {
    font-size: 14px;
    margin-right: 5px;
  }
`;

export class GameStats extends React.Component<IProps & IDerivedProps & I18nProps, void> {
  render () {
    const {t, cave, game = {} as IGameRecord, downloadKey, mdash = true} = this.props;
    const classification = game.classification || "game";
    const classAction = actionForGame(game, cave);

    if (cave) {
      return <GameStatsDiv>
        <TotalPlaytime game={game} cave={cave}/>
        <LastPlayed game={game} cave={cave}/>
      </GameStatsDiv>;
    } else {
      const platforms: JSX.Element[] = [];
      if (classAction === "launch") {
        for (const p of platformData) {
          if ((game as any)[p.field]) {
            platforms.push(<Icon hint={p.platform} icon={p.icon}/>);
          }
        }
      }
      const {minPrice, sale, currency = "USD"} = game;

      return <GameStatsDiv>
        <div className="total-playtime">
        {t(`usage_stats.description.${classification}`)}
        {(platforms.length > 0)
          ? [" ", interleave(t, "usage_stats.description.platforms", {platforms})]
          : ""
        }
        {mdash ? " — " : <br/>}
        {downloadKey
          ? interleave(t, "usage_stats.description.bought_time_ago",
              {time_ago: <TimeAgo date={downloadKey.createdAt}/>})
          : (minPrice > 0
            ? interleave(t, "usage_stats.description.price", {
              price: (sale ?
                [
                  <label className="original-price">
                    {format.price(currency, minPrice)}
                  </label>,
                  <label>
                    {" "}
                    {format.price(currency, minPrice * (1 - sale.rate / 100))}
                  </label>,
                ]
              : <label>
                 {format.price(currency, minPrice)}
                </label>
              ),
            })
            : t("usage_stats.description.free_download")
          )
        }
        </div>
      </GameStatsDiv>;
    }
  }
}

interface IProps {
  game: IGameRecord;
  mdash?: boolean;
}

interface IDerivedProps {
  cave?: ICaveRecord;
  downloadKey: IDownloadKey;
}

export default connect<IProps>(GameStats, {
  state: () => {
    return createSelector(
      (state: IAppState, props: IProps) => state.market,
      (state: IAppState, props: IProps) => state.globalMarket,
      (state: IAppState, props: IProps) => props.game,
      (userMarket, globalMarket, game) => ({
        downloadKey: findWhere((userMarket || {} as IUserMarketState).downloadKeys || {}, { gameId: game.id }),
        cave: globalMarket.cavesByGameId[game.id],
      }),
    );
  },
});