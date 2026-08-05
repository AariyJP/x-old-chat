export const BEARER_TOKEN =
  "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"

export const API_BASE = "https://x.com/i/api"

export const LIVE_PIPELINE_BASE = "https://api.x.com"

export const USER_BY_SCREEN_NAME_QUERY_ID_FALLBACK =
  "2qvSHpkWTMS9i0zJAwDNiA"

export const USER_BY_SCREEN_NAME_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true
}

export const DM_NEW2_QUERY = new URLSearchParams({
  ext: "mediaColor,altText,mediaStats,highlightedLabel,parodyCommentaryFanLabel,voiceInfo,birdwatchPivot,superFollowMetadata,unmentionInfo,editControl,article",
  include_ext_alt_text: "true",
  include_ext_limited_action_results: "true",
  include_reply_count: "1",
  tweet_mode: "extended",
  include_ext_views: "true",
  include_groups: "true",
  include_inbox_timelines: "true",
  include_ext_media_color: "true",
  supports_reactions: "true",
  supports_edit: "true"
}).toString()

export const DM_INBOX_QUERY = new URLSearchParams({
  dm_users: "true",
  include_groups: "true",
  include_inbox_timelines: "true",
  supports_reactions: "true",
  ext: "mediaColor,altText,mediaStats"
}).toString()

export const DM_CONVERSATION_QUERY = new URLSearchParams({
  context: "FETCH_DM_CONVERSATION",
  dm_users: "true",
  include_groups: "true",
  supports_reactions: "true",
  supports_edit: "true",
  ext: "mediaColor,altText,mediaStats"
}).toString()

export const COMPOSE_PATH = "/messages/compose"

export const MESSAGES_PATH = "/messages"

export const CHAT_PATH = "/i/chat"

export const HOME_PATH = "/home"

export const DIRECT_MESSAGE_TAB_SELECTOR =
  '[data-testid="AppTabBar_DirectMessage_Link"]'

export const OPEN_VIEWER_KEY = "xoc-open-viewer"
